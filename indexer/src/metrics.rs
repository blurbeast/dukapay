//! Prometheus metrics + an HTTP server exposing `/metrics`, `/healthz`, and `/readyz`.
//! Health signals: lag (ledgers behind tip), throughput (events/sec via counter
//! rate), error rate (fetch/process error counters), Kafka connectivity, checkpoint DB,
//! and RPC liveness.

use crate::checkpoint::AnyCheckpointStore;
use crate::rpc::SorobanRpc;
use anyhow::Result;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use once_cell::sync::Lazy;
use prometheus::{
    register_int_counter, register_int_counter_vec, register_int_gauge, register_int_gauge_vec,
    Encoder, IntCounter, IntCounterVec, IntGauge, IntGaugeVec, TextEncoder,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::RwLock;
use std::time::Duration;
use tokio::net::TcpListener;

pub static LEDGER_LAG: Lazy<IntGaugeVec> = Lazy::new(|| {
    register_int_gauge_vec!(
        "indexer_ledger_lag",
        "Ledgers between the last processed ledger and the network tip",
        &["contract_id"]
    )
    .unwrap()
});

pub static LAG_OK: Lazy<IntGauge> = Lazy::new(|| {
    register_int_gauge!(
        "indexer_lag_ok",
        "1 when all contracts are within the lag alert threshold, else 0"
    )
    .unwrap()
});

pub static LAST_PROCESSED_LEDGER: Lazy<IntGaugeVec> = Lazy::new(|| {
    register_int_gauge_vec!(
        "indexer_last_processed_ledger",
        "Last fully processed ledger per contract",
        &["contract_id"]
    )
    .unwrap()
});

pub static EVENTS_PROCESSED: Lazy<IntCounterVec> = Lazy::new(|| {
    register_int_counter_vec!(
        "indexer_events_processed_total",
        "Contract events decoded and emitted to the sink",
        &["contract_id", "event_type"]
    )
    .unwrap()
});

pub static FETCH_ERRORS: Lazy<IntCounter> =
    Lazy::new(|| register_int_counter!("indexer_fetch_errors_total", "RPC fetch errors").unwrap());

pub static PROCESS_ERRORS: Lazy<IntCounter> = Lazy::new(|| {
    register_int_counter!(
        "indexer_process_errors_total",
        "Errors while decoding or emitting an event"
    )
    .unwrap()
});

pub static FAILED_EVENTS: Lazy<IntCounter> = Lazy::new(|| {
    register_int_counter!(
        "indexer_failed_events_total",
        "Events that exhausted processing retries"
    )
    .unwrap()
});

pub static DEAD_LETTER_EVENTS: Lazy<IntCounter> = Lazy::new(|| {
    register_int_counter!(
        "indexer_dead_letter_events_total",
        "Events durably recorded in the dead-letter queue"
    )
    .unwrap()
});

pub static SINK_WRITES: Lazy<IntCounter> = Lazy::new(|| {
    register_int_counter!("indexer_sink_writes_total", "Successful sink writes").unwrap()
});

static READY: AtomicBool = AtomicBool::new(false);
static PROCESSING_ACTIVE: AtomicBool = AtomicBool::new(false);
static LAST_CHECKPOINT_TIMESTAMP: AtomicI64 = AtomicI64::new(0);
static STARTUP_TIMESTAMP: AtomicI64 = AtomicI64::new(0);
static CURRENT_MAX_LAG: AtomicI64 = AtomicI64::new(0);

static CONTRACT_LAGS: Lazy<RwLock<HashMap<String, i64>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

static HEALTH_CONTEXT: Lazy<RwLock<Option<HealthContext>>> = Lazy::new(|| RwLock::new(None));

#[derive(Clone)]
pub struct HealthContext {
    pub rpc: Option<SorobanRpc>,
    pub checkpoints: Option<AnyCheckpointStore>,
    pub kafka_brokers: Option<String>,
    pub max_lag: i64,
    pub max_checkpoint_age_secs: u64,
}

impl Default for HealthContext {
    fn default() -> Self {
        Self {
            rpc: None,
            checkpoints: None,
            kafka_brokers: None,
            max_lag: 100,
            max_checkpoint_age_secs: 300,
        }
    }
}

pub fn set_ready(v: bool) {
    READY.store(v, Ordering::Relaxed);
}

pub fn set_processing_active(v: bool) {
    PROCESSING_ACTIVE.store(v, Ordering::Relaxed);
}

pub fn init_startup_time() {
    STARTUP_TIMESTAMP.store(chrono::Utc::now().timestamp(), Ordering::Relaxed);
}

pub fn record_checkpoint_saved() {
    LAST_CHECKPOINT_TIMESTAMP.store(chrono::Utc::now().timestamp(), Ordering::Relaxed);
}

#[allow(dead_code)]
pub fn set_last_checkpoint_timestamp(ts: i64) {
    LAST_CHECKPOINT_TIMESTAMP.store(ts, Ordering::Relaxed);
}

#[allow(dead_code)]
pub fn set_startup_timestamp(ts: i64) {
    STARTUP_TIMESTAMP.store(ts, Ordering::Relaxed);
}

#[allow(dead_code)]
pub fn set_current_max_lag(lag: i64) {
    CURRENT_MAX_LAG.store(lag.max(0), Ordering::Relaxed);
}

pub fn record_lag(contract: &str, lag: i64) {
    let lag = lag.max(0);
    LEDGER_LAG.with_label_values(&[contract]).set(lag);
    if let Ok(mut map) = CONTRACT_LAGS.write() {
        map.insert(contract.to_string(), lag);
        let max_lag = map.values().copied().max().unwrap_or(0);
        CURRENT_MAX_LAG.store(max_lag, Ordering::Relaxed);
    }
}

pub fn set_health_context(ctx: HealthContext) {
    if let Ok(mut guard) = HEALTH_CONTEXT.write() {
        *guard = Some(ctx);
    }
}

pub fn get_health_context() -> Option<HealthContext> {
    HEALTH_CONTEXT.read().ok().and_then(|g| g.clone())
}

#[allow(dead_code)]
pub fn reset_health_state() {
    READY.store(false, Ordering::Relaxed);
    PROCESSING_ACTIVE.store(false, Ordering::Relaxed);
    LAST_CHECKPOINT_TIMESTAMP.store(0, Ordering::Relaxed);
    STARTUP_TIMESTAMP.store(0, Ordering::Relaxed);
    CURRENT_MAX_LAG.store(0, Ordering::Relaxed);
    if let Ok(mut map) = CONTRACT_LAGS.write() {
        map.clear();
    }
    if let Ok(mut guard) = HEALTH_CONTEXT.write() {
        *guard = None;
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub timestamp: String,
    pub checks: HealthChecks,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct HealthChecks {
    pub rpc: ComponentStatus,
    pub kafka: ComponentStatus,
    pub lag: ComponentStatus,
    pub checkpoint: ComponentStatus,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadyResponse {
    pub status: String,
    pub timestamp: String,
    pub ready: bool,
    pub processing_active: bool,
    pub dependencies: DependencyChecks,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DependencyChecks {
    pub rpc: ComponentStatus,
    pub checkpoint: ComponentStatus,
    pub kafka: ComponentStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentStatus {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_lag: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_lag: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_age_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_ledger: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brokers: Option<String>,
}

impl ComponentStatus {
    pub fn ok() -> Self {
        Self {
            status: "ok".to_string(),
            message: None,
            error: None,
            current_lag: None,
            max_lag: None,
            age_seconds: None,
            max_age_seconds: None,
            latest_ledger: None,
            brokers: None,
        }
    }

    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            status: "error".to_string(),
            message: None,
            error: Some(msg.into()),
            current_lag: None,
            max_lag: None,
            age_seconds: None,
            max_age_seconds: None,
            latest_ledger: None,
            brokers: None,
        }
    }

    pub fn is_ok(&self) -> bool {
        self.status == "ok"
    }
}

/// Verify Kafka broker connectivity via TCP probe.
pub async fn check_kafka_connectivity(brokers: &str, timeout_dur: Duration) -> Result<()> {
    let mut last_err = None;
    let mut any_broker = false;
    for broker in brokers.split(',') {
        let broker = broker.trim();
        if broker.is_empty() {
            continue;
        }
        any_broker = true;
        let addr = if broker.contains(':') {
            broker.to_string()
        } else {
            format!("{broker}:9092")
        };
        match tokio::time::timeout(timeout_dur, tokio::net::TcpStream::connect(&addr)).await {
            Ok(Ok(_stream)) => return Ok(()),
            Ok(Err(e)) => last_err = Some(anyhow::anyhow!("connection to {addr} failed: {e}")),
            Err(_) => {
                last_err = Some(anyhow::anyhow!(
                    "connection to {addr} timed out after {timeout_dur:?}"
                ))
            }
        }
    }
    if !any_broker {
        anyhow::bail!("no brokers specified");
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("failed to connect to kafka brokers")))
}

/// Run health checks for `/healthz` (liveness).
pub async fn check_health(ctx: &HealthContext) -> (StatusCode, HealthResponse) {
    let mut errors = Vec::new();

    // 1. RPC connectivity check
    let rpc_status = match &ctx.rpc {
        Some(rpc) => {
            match tokio::time::timeout(Duration::from_secs(3), rpc.latest_ledger()).await {
                Ok(Ok(seq)) => {
                    let mut s = ComponentStatus::ok();
                    s.latest_ledger = Some(seq);
                    s
                }
                Ok(Err(e)) => {
                    let err_msg = format!("RPC getLatestLedger error: {e}");
                    errors.push(format!("rpc: {err_msg}"));
                    ComponentStatus::error(err_msg)
                }
                Err(_) => {
                    let err_msg = "RPC getLatestLedger timed out after 3s".to_string();
                    errors.push(format!("rpc: {err_msg}"));
                    ComponentStatus::error(err_msg)
                }
            }
        }
        None => {
            let err_msg = "RPC client not configured".to_string();
            errors.push(format!("rpc: {err_msg}"));
            ComponentStatus::error(err_msg)
        }
    };

    // 2. Kafka connectivity check
    let kafka_status = match &ctx.kafka_brokers {
        Some(brokers) => match check_kafka_connectivity(brokers, Duration::from_secs(2)).await {
            Ok(()) => {
                let mut s = ComponentStatus::ok();
                s.brokers = Some(brokers.clone());
                s
            }
            Err(e) => {
                let err_msg = format!("{e}");
                errors.push(format!("kafka: {err_msg}"));
                let mut s = ComponentStatus::error(err_msg);
                s.brokers = Some(brokers.clone());
                s
            }
        },
        None => {
            let mut s = ComponentStatus::ok();
            s.message = Some("not configured".to_string());
            s
        }
    };

    // 3. Lag check
    let current_lag = CURRENT_MAX_LAG.load(Ordering::Relaxed);
    let lag_status = if current_lag <= ctx.max_lag {
        let mut s = ComponentStatus::ok();
        s.current_lag = Some(current_lag);
        s.max_lag = Some(ctx.max_lag);
        s
    } else {
        let err_msg = format!(
            "current lag {current_lag} exceeds threshold {}",
            ctx.max_lag
        );
        errors.push(format!("lag: {err_msg}"));
        let mut s = ComponentStatus::error(err_msg);
        s.current_lag = Some(current_lag);
        s.max_lag = Some(ctx.max_lag);
        s
    };

    // 4. Last checkpoint age check
    let last_cp = LAST_CHECKPOINT_TIMESTAMP.load(Ordering::Relaxed);
    let startup = STARTUP_TIMESTAMP.load(Ordering::Relaxed);
    let now = chrono::Utc::now().timestamp();
    let ref_time = if last_cp > 0 { last_cp } else { startup };
    let age_seconds = if ref_time > 0 {
        (now - ref_time).max(0) as u64
    } else {
        0
    };

    let mut checkpoint_status = if age_seconds <= ctx.max_checkpoint_age_secs {
        let mut s = ComponentStatus::ok();
        s.age_seconds = Some(age_seconds);
        s.max_age_seconds = Some(ctx.max_checkpoint_age_secs);
        s
    } else {
        let err_msg = format!(
            "checkpoint age {age_seconds}s exceeds threshold {}s",
            ctx.max_checkpoint_age_secs
        );
        errors.push(format!("checkpoint: {err_msg}"));
        let mut s = ComponentStatus::error(err_msg);
        s.age_seconds = Some(age_seconds);
        s.max_age_seconds = Some(ctx.max_checkpoint_age_secs);
        s
    };

    if let Some(store) = &ctx.checkpoints {
        if let Err(e) = store.check_health().await {
            let err_msg = format!("checkpoint store error: {e}");
            errors.push(format!("checkpoint: {err_msg}"));
            checkpoint_status = ComponentStatus::error(err_msg);
            checkpoint_status.age_seconds = Some(age_seconds);
            checkpoint_status.max_age_seconds = Some(ctx.max_checkpoint_age_secs);
        }
    }

    let is_healthy = rpc_status.is_ok()
        && kafka_status.is_ok()
        && lag_status.is_ok()
        && checkpoint_status.is_ok();

    let status_code = if is_healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    let resp = HealthResponse {
        status: if is_healthy {
            "healthy".to_string()
        } else {
            "unhealthy".to_string()
        },
        timestamp: chrono::Utc::now().to_rfc3339(),
        checks: HealthChecks {
            rpc: rpc_status,
            kafka: kafka_status,
            lag: lag_status,
            checkpoint: checkpoint_status,
        },
        errors,
    };

    (status_code, resp)
}

/// Run readiness checks for `/readyz` (all dependencies connected and processing active).
pub async fn check_readiness(ctx: &HealthContext) -> (StatusCode, ReadyResponse) {
    let mut errors = Vec::new();
    let ready = READY.load(Ordering::Relaxed);
    let processing_active = PROCESSING_ACTIVE.load(Ordering::Relaxed);

    if !ready {
        errors.push("startup initialization not complete".to_string());
    }
    if !processing_active {
        errors.push("event processing is inactive".to_string());
    }

    // Dependency 1: RPC connectivity
    let rpc_status = match &ctx.rpc {
        Some(rpc) => {
            match tokio::time::timeout(Duration::from_secs(3), rpc.latest_ledger()).await {
                Ok(Ok(seq)) => {
                    let mut s = ComponentStatus::ok();
                    s.latest_ledger = Some(seq);
                    s
                }
                Ok(Err(e)) => {
                    let err_msg = format!("RPC getLatestLedger error: {e}");
                    errors.push(format!("rpc: {err_msg}"));
                    ComponentStatus::error(err_msg)
                }
                Err(_) => {
                    let err_msg = "RPC getLatestLedger timed out after 3s".to_string();
                    errors.push(format!("rpc: {err_msg}"));
                    ComponentStatus::error(err_msg)
                }
            }
        }
        None => {
            let err_msg = "RPC client not configured".to_string();
            errors.push(format!("rpc: {err_msg}"));
            ComponentStatus::error(err_msg)
        }
    };

    // Dependency 2: Checkpoint store accessibility
    let checkpoint_status = match &ctx.checkpoints {
        Some(store) => match store.check_health().await {
            Ok(()) => ComponentStatus::ok(),
            Err(e) => {
                let err_msg = format!("checkpoint store error: {e}");
                errors.push(format!("checkpoint: {err_msg}"));
                ComponentStatus::error(err_msg)
            }
        },
        None => {
            let err_msg = "checkpoint store not initialized".to_string();
            errors.push(format!("checkpoint: {err_msg}"));
            ComponentStatus::error(err_msg)
        }
    };

    // Dependency 3: Kafka connectivity
    let kafka_status = match &ctx.kafka_brokers {
        Some(brokers) => match check_kafka_connectivity(brokers, Duration::from_secs(2)).await {
            Ok(()) => {
                let mut s = ComponentStatus::ok();
                s.brokers = Some(brokers.clone());
                s
            }
            Err(e) => {
                let err_msg = format!("{e}");
                errors.push(format!("kafka: {err_msg}"));
                let mut s = ComponentStatus::error(err_msg);
                s.brokers = Some(brokers.clone());
                s
            }
        },
        None => {
            let mut s = ComponentStatus::ok();
            s.message = Some("not configured".to_string());
            s
        }
    };

    let is_ready = ready
        && processing_active
        && rpc_status.is_ok()
        && checkpoint_status.is_ok()
        && kafka_status.is_ok();

    let status_code = if is_ready {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    let resp = ReadyResponse {
        status: if is_ready {
            "ready".to_string()
        } else {
            "not_ready".to_string()
        },
        timestamp: chrono::Utc::now().to_rfc3339(),
        ready,
        processing_active,
        dependencies: DependencyChecks {
            rpc: rpc_status,
            checkpoint: checkpoint_status,
            kafka: kafka_status,
        },
        errors,
    };

    (status_code, resp)
}

async fn handle(req: Request<hyper::body::Incoming>) -> Result<Response<Full<Bytes>>> {
    handle_path(req.uri().path()).await
}

pub async fn handle_path(path: &str) -> Result<Response<Full<Bytes>>> {
    let ctx = get_health_context().unwrap_or_default();
    let resp = match path {
        "/metrics" => {
            let mut buf = Vec::new();
            let encoder = TextEncoder::new();
            encoder.encode(&prometheus::gather(), &mut buf)?;
            Response::builder()
                .header("content-type", encoder.format_type())
                .body(Full::new(Bytes::from(buf)))?
        }
        "/healthz" => {
            let (status, health) = check_health(&ctx).await;
            let body = serde_json::to_vec_pretty(&health)?;
            Response::builder()
                .status(status)
                .header("content-type", "application/json")
                .body(Full::new(Bytes::from(body)))?
        }
        "/readyz" => {
            let (status, ready) = check_readiness(&ctx).await;
            let body = serde_json::to_vec_pretty(&ready)?;
            Response::builder()
                .status(status)
                .header("content-type", "application/json")
                .body(Full::new(Bytes::from(body)))?
        }
        _ => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Full::new(Bytes::from("not found")))?,
    };
    Ok(resp)
}

pub async fn serve(port: u16) -> Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    serve_listener(listener).await
}

pub async fn serve_listener(listener: TcpListener) -> Result<()> {
    let addr = listener.local_addr()?;
    tracing::info!(port = addr.port(), "metrics server listening");
    loop {
        let (stream, _) = listener.accept().await?;
        let io = TokioIo::new(stream);
        tokio::spawn(async move {
            if let Err(e) = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, service_fn(handle))
                .await
            {
                tracing::debug!(error = %e, "metrics connection closed");
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checkpoint::FileCheckpointStore;
    use http_body_util::BodyExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn spawn_mock_rpc_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("http://{addr}");
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 1024];
                    let _ = socket.read(&mut buf).await;
                    let body = r#"{"jsonrpc":"2.0","id":1,"result":{"sequence":12345}}"#;
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = socket.write_all(resp.as_bytes()).await;
                });
            }
        });
        (url, handle)
    }

    #[tokio::test]
    async fn test_health_check_returns_503_when_kafka_unreachable() {
        let _lock = TEST_LOCK.lock().await;
        reset_health_state();
        let (rpc_url, rpc_handle) = spawn_mock_rpc_server().await;

        let ctx = HealthContext {
            rpc: Some(SorobanRpc::new(rpc_url)),
            checkpoints: None,
            kafka_brokers: Some("127.0.0.1:1".to_string()),
            max_lag: 100,
            max_checkpoint_age_secs: 300,
        };
        set_health_context(ctx);
        set_ready(true);
        set_processing_active(true);
        init_startup_time();

        let resp = handle_path("/healthz").await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let health: HealthResponse = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(health.status, "unhealthy");
        assert_eq!(health.checks.kafka.status, "error");
        assert!(health.checks.kafka.error.is_some());
        assert!(!health.errors.is_empty());
        assert!(health.errors.iter().any(|e| e.contains("kafka")));

        rpc_handle.abort();
    }

    #[tokio::test]
    async fn test_health_check_returns_503_when_rpc_unreachable() {
        let _lock = TEST_LOCK.lock().await;
        reset_health_state();
        let ctx = HealthContext {
            rpc: Some(SorobanRpc::new("http://127.0.0.1:1")),
            checkpoints: None,
            kafka_brokers: None,
            max_lag: 100,
            max_checkpoint_age_secs: 300,
        };
        set_health_context(ctx);
        set_ready(true);
        set_processing_active(true);
        init_startup_time();

        let resp = handle_path("/healthz").await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let health: HealthResponse = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(health.status, "unhealthy");
        assert_eq!(health.checks.rpc.status, "error");
        assert!(health.checks.rpc.error.is_some());
    }

    #[tokio::test]
    async fn test_health_check_returns_503_when_lag_exceeds_threshold() {
        let _lock = TEST_LOCK.lock().await;
        reset_health_state();
        let (rpc_url, rpc_handle) = spawn_mock_rpc_server().await;

        let ctx = HealthContext {
            rpc: Some(SorobanRpc::new(rpc_url)),
            checkpoints: None,
            kafka_brokers: None,
            max_lag: 50,
            max_checkpoint_age_secs: 300,
        };
        set_health_context(ctx);
        set_ready(true);
        set_processing_active(true);
        init_startup_time();
        set_current_max_lag(150);

        let resp = handle_path("/healthz").await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let health: HealthResponse = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(health.status, "unhealthy");
        assert_eq!(health.checks.lag.status, "error");
        assert_eq!(health.checks.lag.current_lag, Some(150));
        assert_eq!(health.checks.lag.max_lag, Some(50));

        rpc_handle.abort();
    }

    #[tokio::test]
    async fn test_health_check_returns_503_when_checkpoint_age_exceeds_threshold() {
        let _lock = TEST_LOCK.lock().await;
        reset_health_state();
        let (rpc_url, rpc_handle) = spawn_mock_rpc_server().await;

        let ctx = HealthContext {
            rpc: Some(SorobanRpc::new(rpc_url)),
            checkpoints: None,
            kafka_brokers: None,
            max_lag: 100,
            max_checkpoint_age_secs: 60,
        };
        set_health_context(ctx);
        set_ready(true);
        set_processing_active(true);
        set_startup_timestamp(chrono::Utc::now().timestamp() - 200);

        let resp = handle_path("/healthz").await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let health: HealthResponse = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(health.status, "unhealthy");
        assert_eq!(health.checks.checkpoint.status, "error");
        assert!(health.checks.checkpoint.age_seconds.unwrap() >= 200);

        rpc_handle.abort();
    }

    #[tokio::test]
    async fn test_readyz_returns_503_when_starting_or_inactive() {
        let _lock = TEST_LOCK.lock().await;
        reset_health_state();
        let (rpc_url, rpc_handle) = spawn_mock_rpc_server().await;

        let ctx = HealthContext {
            rpc: Some(SorobanRpc::new(rpc_url)),
            checkpoints: None,
            kafka_brokers: None,
            max_lag: 100,
            max_checkpoint_age_secs: 300,
        };
        set_health_context(ctx);
        set_ready(false);
        set_processing_active(false);

        let resp = handle_path("/readyz").await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let ready: ReadyResponse = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(ready.status, "not_ready");
        assert!(!ready.ready);
        assert!(!ready.processing_active);

        // When ready is true but processing_active is false:
        set_ready(true);
        set_processing_active(false);
        let resp = handle_path("/readyz").await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);

        rpc_handle.abort();
    }

    #[tokio::test]
    async fn test_healthy_and_ready_return_200() {
        let _lock = TEST_LOCK.lock().await;
        reset_health_state();
        let (rpc_url, rpc_handle) = spawn_mock_rpc_server().await;

        // Mock Kafka listening on an ephemeral port
        let kafka_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let kafka_addr = kafka_listener.local_addr().unwrap().to_string();

        let tmp_file = std::env::temp_dir().join(format!("test-cp-{}.json", std::process::id()));
        let store = FileCheckpointStore::new(tmp_file.to_string_lossy())
            .await
            .unwrap();

        let ctx = HealthContext {
            rpc: Some(SorobanRpc::new(rpc_url)),
            checkpoints: Some(AnyCheckpointStore::File(store)),
            kafka_brokers: Some(kafka_addr),
            max_lag: 100,
            max_checkpoint_age_secs: 300,
        };
        set_health_context(ctx);
        set_ready(true);
        set_processing_active(true);
        init_startup_time();
        record_checkpoint_saved();
        set_current_max_lag(5);

        let resp = handle_path("/healthz").await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body_bytes = resp.into_body().collect().await.unwrap().to_bytes();
        let health: HealthResponse = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(health.status, "healthy");
        assert_eq!(health.checks.rpc.status, "ok");
        assert_eq!(health.checks.rpc.latest_ledger, Some(12345));
        assert_eq!(health.checks.kafka.status, "ok");
        assert_eq!(health.checks.lag.status, "ok");
        assert_eq!(health.checks.checkpoint.status, "ok");

        let ready_resp = handle_path("/readyz").await.unwrap();
        assert_eq!(ready_resp.status(), StatusCode::OK);
        let ready_bytes = ready_resp.into_body().collect().await.unwrap().to_bytes();
        let ready: ReadyResponse = serde_json::from_slice(&ready_bytes).unwrap();
        assert_eq!(ready.status, "ready");
        assert!(ready.ready);
        assert!(ready.processing_active);
        assert_eq!(ready.dependencies.rpc.status, "ok");
        assert_eq!(ready.dependencies.checkpoint.status, "ok");
        assert_eq!(ready.dependencies.kafka.status, "ok");

        let _ = tokio::fs::remove_file(tmp_file).await;
        rpc_handle.abort();
    }

    #[tokio::test]
    async fn test_http_server_serves_endpoints() {
        let _lock = TEST_LOCK.lock().await;
        reset_health_state();
        let (rpc_url, rpc_handle) = spawn_mock_rpc_server().await;

        let ctx = HealthContext {
            rpc: Some(SorobanRpc::new(rpc_url)),
            checkpoints: None,
            kafka_brokers: Some("127.0.0.1:1".to_string()),
            max_lag: 100,
            max_checkpoint_age_secs: 300,
        };
        set_health_context(ctx);
        set_ready(true);
        set_processing_active(true);
        init_startup_time();

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server_handle = tokio::spawn(async move {
            let _ = serve_listener(listener).await;
        });

        let client = reqwest::Client::new();
        let resp = client
            .get(format!("http://127.0.0.1:{port}/healthz"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body: HealthResponse = resp.json().await.unwrap();
        assert_eq!(body.status, "unhealthy");
        assert_eq!(body.checks.kafka.status, "error");

        let metrics_resp = client
            .get(format!("http://127.0.0.1:{port}/metrics"))
            .send()
            .await
            .unwrap();
        assert_eq!(metrics_resp.status(), StatusCode::OK);

        server_handle.abort();
        rpc_handle.abort();
    }
}
