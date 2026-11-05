//! A package's worker domain beside its rquickjs UI realm. The worker boots
//! after the UI realm and before the UI bundle evaluates, so its channels exist
//! when the bridge attaches; the bridge latches the worker's records before
//! every frame and detaches before the worker stops.
//!
//! [`WorkerDomain`] is the part a program's own guest wrapper calls (Omarchy
//! Pocket's windowed apps); [`WorkerGuest`] is a whole guest for a program that
//! runs one package on the rquickjs guest (Pocket Hub's CardputerZero program).
use crate::http::{Exchange, HttpNode, MAX_RESPONSE_BYTES};
use crate::runner::{
    pocket_worker_ui_attach, pocket_worker_ui_detach, pocket_worker_ui_latch, Bridge, Notify,
    Worker,
};
use pocket_guest_rquickjs::RquickjsGuest;
use pocket_runtime::{Guest, GuestEnvironment, GuestFrame, OpContext, RuntimeError};
use std::{ptr, sync::Arc};

pub struct WorkerDomain {
    http: Arc<HttpNode>,
    notify: Arc<Notify>,
    bridge: *mut Bridge,
    worker: Option<Worker>,
}

impl WorkerDomain {
    /// A domain whose http node admits responses of the floor every host
    /// holds (MAX_RESPONSE_BYTES).
    pub fn new(exchange: Box<dyn Exchange>) -> Self {
        Self::with_response_bytes(exchange, MAX_RESPONSE_BYTES)
    }

    /// A domain whose http node admits responses of up to `response_bytes`:
    /// the program's host contract (`contract_response_bytes`).
    pub fn with_response_bytes(exchange: Box<dyn Exchange>, response_bytes: usize) -> Self {
        let notify = Arc::new(Notify::default());
        Self {
            http: HttpNode::new(exchange, notify.clone(), response_bytes),
            notify,
            bridge: ptr::null_mut(),
            worker: None,
        }
    }

    /// Whether the package declared a worker and it runs.
    pub fn running(&self) -> bool {
        self.worker.is_some()
    }

    /// Start the package's worker, when it has one, and attach the UI realm's
    /// bridge to it. Call after the UI realm initialized and before the UI
    /// bundle evaluates.
    pub fn start(
        &mut self,
        guest: &RquickjsGuest,
        environment: &GuestEnvironment<'_>,
    ) -> Result<(), String> {
        self.stop(guest);
        if environment.worker_javascript.is_empty() {
            return Ok(());
        }
        let worker = Worker::start(
            environment.worker_javascript,
            self.http.clone(),
            self.notify.clone(),
        )?;
        let core = worker.core();
        self.worker = Some(worker);
        self.bridge = guest
            .with(|ctx| unsafe { pocket_worker_ui_attach(ctx.as_raw().as_ptr(), core) })
            .unwrap_or(ptr::null_mut());
        if self.bridge.is_null() {
            self.worker = None;
            return Err("channel bridge attachment failed".into());
        }
        Ok(())
    }

    /// Before each UI frame: the worker's fault, or its records latched into
    /// the UI realm's channels.
    pub fn latch(&mut self, guest: &RquickjsGuest) -> Result<(), String> {
        if let Some(fault) = self.worker.as_ref().and_then(Worker::fault) {
            return Err(fault);
        }
        if self.bridge.is_null() {
            return Ok(());
        }
        let bridge = self.bridge;
        let latched = guest.with(|ctx| {
            if unsafe { pocket_worker_ui_latch(bridge) } >= 0 {
                return Ok(());
            }
            let thrown = ctx.catch();
            Err(thrown
                .as_exception()
                .and_then(|exception| exception.message())
                .unwrap_or_else(|| "channel latch failed".into()))
        });
        latched.unwrap_or(Ok(()))
    }

    /// Detach the bridge, then stop the worker. Call before the UI realm goes.
    pub fn stop(&mut self, guest: &RquickjsGuest) {
        if !self.bridge.is_null() {
            let bridge = std::mem::replace(&mut self.bridge, ptr::null_mut());
            guest.with(|_| unsafe { pocket_worker_ui_detach(bridge) });
        }
        self.worker = None;
    }
}

/// The rquickjs guest with the package's worker domain.
pub struct WorkerGuest {
    inner: RquickjsGuest,
    domain: WorkerDomain,
    /// Names the program in what it prints when the worker fails.
    program: &'static str,
}

impl WorkerGuest {
    pub fn new(program: &'static str, exchange: Box<dyn Exchange>) -> Self {
        Self {
            inner: RquickjsGuest::default(),
            domain: WorkerDomain::new(exchange),
            program,
        }
    }
    fn fail(&self, message: impl std::fmt::Display) -> RuntimeError {
        eprintln!("{}: worker: {message}", self.program);
        RuntimeError::Guest
    }
}

impl Guest for WorkerGuest {
    fn initialize(
        &mut self,
        ops: OpContext,
        environment: &GuestEnvironment<'_>,
    ) -> Result<(), RuntimeError> {
        self.shutdown();
        self.inner.initialize(ops, environment)?;
        self.domain
            .start(&self.inner, environment)
            .map_err(|message| self.fail(message))
    }
    fn evaluate(&mut self, code: &[u8]) -> Result<(), RuntimeError> {
        self.inner.evaluate(code)
    }
    fn frame(&mut self, frame: &GuestFrame<'_>) -> Result<(), RuntimeError> {
        if let Err(message) = self.domain.latch(&self.inner) {
            return Err(self.fail(message));
        }
        self.inner.frame(frame)
    }
    fn collect(&mut self) -> Result<(), RuntimeError> {
        self.inner.collect()
    }
    fn shutdown(&mut self) {
        self.domain.stop(&self.inner);
        self.inner.shutdown()
    }
}
