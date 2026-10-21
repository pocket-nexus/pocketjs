//! Event assertions shared by runtime, render and display tests.
use alloc::vec::Vec;

/// IDs are assigned by the test and unique until their state retires. Buffer
/// IDs describe physical storage; alternating staging buffers need distinct IDs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Acquire(u64),
    Render {
        submission: u64,
        buffer: u64,
    },
    UseResource {
        submission: u64,
        resource: u64,
    },
    RenderStopped(u64),
    RenderWaited {
        submission: u64,
        failed: bool,
    },
    Flush {
        transfer: u64,
        submission: u64,
        buffer: u64,
    },
    DisplayStopped(u64),
    DisplayWaited {
        transfer: u64,
        failed: bool,
    },
    Retire(u64),
    ReleaseResource(u64),
    Invalidate(u64),
    FrameEnd {
        failed: bool,
    },
    Destroy,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViolationKind {
    Capacity,
    UnknownId,
    DuplicateId,
    BufferBusy,
    WaitBeforeStop,
    FlushBeforeRenderWait,
    RetireBeforeStop,
    ResourceStillReferenced,
    MissingInvalidation,
    PendingWork,
    FailureNotReported,
    MissingFrameEnd,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Violation {
    pub event: usize,
    pub kind: ViolationKind,
}
struct Job {
    id: u64,
    buffer: u64,
    stopped: bool,
    waited: bool,
    failed: bool,
}
struct Transfer {
    id: u64,
    submission: u64,
    buffer: u64,
    stopped: bool,
}

/// Bounded audit state. `capacity` bounds each pending-work/resource table;
/// tests cannot discard an overflowing trace and report success. The first
/// violation is sticky. Frame boundaries permit reusing the same instance.
pub struct Lifecycle {
    capacity: usize,
    index: usize,
    failed: Option<Violation>,
    jobs: Vec<Job>,
    transfers: Vec<Transfer>,
    resources: Vec<(u64, u64)>,
    acquired: Vec<u64>,
    dirty_failures: Vec<u64>,
    saw_failure: bool,
    open_frame: bool,
}
impl Lifecycle {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            index: 0,
            failed: None,
            jobs: Vec::new(),
            transfers: Vec::new(),
            resources: Vec::new(),
            acquired: Vec::new(),
            dirty_failures: Vec::new(),
            saw_failure: false,
            open_frame: false,
        }
    }
    fn room(&self, length: usize) -> Result<(), ViolationKind> {
        if length < self.capacity {
            Ok(())
        } else {
            Err(ViolationKind::Capacity)
        }
    }
    fn failure(&mut self, buffer: u64) -> Result<(), ViolationKind> {
        self.saw_failure = true;
        if !self.dirty_failures.contains(&buffer) {
            self.room(self.dirty_failures.len())?;
            self.dirty_failures.push(buffer);
        }
        Ok(())
    }
    /// Append one observation. Continue draining real hardware after Err; the
    /// audit error must never replace the driver's cleanup obligations.
    pub fn observe(&mut self, event: Event) -> Result<(), Violation> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        let index = self.index;
        self.index += 1;
        self.apply(event).map_err(|kind| {
            let error = Violation { event: index, kind };
            self.failed = Some(error);
            error
        })
    }
    /// Check a completed frame/destruction trace, including missing last events.
    pub fn finish(&self) -> Result<(), Violation> {
        if let Some(error) = self.failed {
            return Err(error);
        }
        let kind =
            if !self.jobs.is_empty() || !self.transfers.is_empty() || !self.resources.is_empty() {
                Some(ViolationKind::PendingWork)
            } else if !self.dirty_failures.is_empty() {
                Some(ViolationKind::MissingInvalidation)
            } else if self.open_frame {
                Some(ViolationKind::MissingFrameEnd)
            } else {
                None
            };
        match kind {
            Some(kind) => Err(Violation {
                event: self.index,
                kind,
            }),
            None => Ok(()),
        }
    }
    fn apply(&mut self, event: Event) -> Result<(), ViolationKind> {
        use ViolationKind::*;
        match event {
            Event::Acquire(buffer) => {
                self.open_frame = true;
                if self.jobs.iter().any(|j| j.buffer == buffer)
                    || self.transfers.iter().any(|t| t.buffer == buffer)
                {
                    return Err(BufferBusy);
                }
                if !self.acquired.contains(&buffer) {
                    self.room(self.acquired.len())?;
                    self.acquired.push(buffer);
                }
            }
            Event::Render { submission, buffer } => {
                if self.jobs.iter().any(|j| j.id == submission) {
                    return Err(DuplicateId);
                }
                if self.jobs.iter().any(|j| j.buffer == buffer)
                    || self.transfers.iter().any(|t| t.buffer == buffer)
                {
                    return Err(BufferBusy);
                }
                let at = self
                    .acquired
                    .iter()
                    .position(|b| *b == buffer)
                    .ok_or(UnknownId)?;
                self.room(self.jobs.len())?;
                self.acquired.swap_remove(at);
                self.jobs.push(Job {
                    id: submission,
                    buffer,
                    stopped: false,
                    waited: false,
                    failed: false,
                });
            }
            Event::UseResource {
                submission,
                resource,
            } => {
                if !self.jobs.iter().any(|j| j.id == submission) {
                    return Err(UnknownId);
                }
                if !self.resources.contains(&(submission, resource)) {
                    self.room(self.resources.len())?;
                    self.resources.push((submission, resource));
                }
            }
            Event::RenderStopped(id) => {
                self.jobs
                    .iter_mut()
                    .find(|j| j.id == id)
                    .ok_or(UnknownId)?
                    .stopped = true
            }
            Event::RenderWaited { submission, failed } => {
                let job = self
                    .jobs
                    .iter_mut()
                    .find(|j| j.id == submission)
                    .ok_or(UnknownId)?;
                if !job.stopped {
                    return Err(WaitBeforeStop);
                }
                job.waited = true;
                job.failed |= failed;
                let buffer = job.buffer;
                if failed {
                    self.failure(buffer)?;
                }
            }
            Event::Flush {
                transfer,
                submission,
                buffer,
            } => {
                if self.transfers.iter().any(|t| t.id == transfer) {
                    return Err(DuplicateId);
                }
                let job = self
                    .jobs
                    .iter()
                    .find(|j| j.id == submission)
                    .ok_or(UnknownId)?;
                if job.buffer != buffer || !job.waited || job.failed {
                    return Err(FlushBeforeRenderWait);
                }
                if self.transfers.iter().any(|t| t.buffer == buffer) {
                    return Err(BufferBusy);
                }
                self.room(self.transfers.len())?;
                self.transfers.push(Transfer {
                    id: transfer,
                    submission,
                    buffer,
                    stopped: false,
                });
            }
            Event::DisplayStopped(id) => {
                self.transfers
                    .iter_mut()
                    .find(|t| t.id == id)
                    .ok_or(UnknownId)?
                    .stopped = true
            }
            Event::DisplayWaited { transfer, failed } => {
                let at = self
                    .transfers
                    .iter()
                    .position(|t| t.id == transfer)
                    .ok_or(UnknownId)?;
                if !self.transfers[at].stopped {
                    return Err(WaitBeforeStop);
                }
                let token = self.transfers.swap_remove(at);
                if failed {
                    self.failure(token.buffer)?;
                }
            }
            Event::Retire(id) => {
                let at = self.jobs.iter().position(|j| j.id == id).ok_or(UnknownId)?;
                if !self.jobs[at].stopped || self.transfers.iter().any(|t| t.submission == id) {
                    return Err(RetireBeforeStop);
                }
                self.jobs.swap_remove(at);
                self.resources.retain(|(submission, _)| *submission != id);
            }
            Event::ReleaseResource(id) => {
                if self.resources.iter().any(|(_, resource)| *resource == id) {
                    return Err(ResourceStillReferenced);
                }
            }
            Event::Invalidate(buffer) => self.dirty_failures.retain(|b| *b != buffer),
            Event::FrameEnd { failed } => {
                if !self.jobs.is_empty() || !self.transfers.is_empty() {
                    return Err(PendingWork);
                }
                if self.saw_failure && !failed {
                    return Err(FailureNotReported);
                }
                if !self.dirty_failures.is_empty() {
                    return Err(MissingInvalidation);
                }
                self.acquired.clear();
                self.saw_failure = false;
                self.open_frame = false;
            }
            Event::Destroy => {
                if !self.jobs.is_empty() || !self.transfers.is_empty() || !self.resources.is_empty()
                {
                    return Err(PendingWork);
                }
                // A destroyed runtime has no history to retain.
                self.dirty_failures.clear();
                self.acquired.clear();
                self.saw_failure = false;
                self.open_frame = false;
            }
        }
        Ok(())
    }
}
