//! Generic bounded native worker adapter for io.offload. The guest only copies
//! records; capability initialization and execution happen on the worker.
use anyhow::Result;
use pocket_mod::{Guest, qjs::Function};
use std::{
    cell::Cell,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicI32, AtomicUsize, Ordering},
        mpsc::{Receiver, SyncSender, sync_channel},
    },
    thread,
};

struct Mailbox {
    tx: SyncSender<String>,
    rx: Receiver<String>,
    session: Arc<AtomicI32>,
    credit: Arc<AtomicUsize>,
    delivered: Cell<bool>,
}
#[derive(Clone)]
pub struct OffloadWorker {
    inner: Rc<Mailbox>,
}
impl OffloadWorker {
    pub fn spawn<F, H>(initialize: F) -> Self
    where
        F: FnOnce() -> H + Send + 'static,
        H: FnMut(&str) -> String + 'static,
    {
        let (tx, requests) = sync_channel::<String>(8);
        let (replies, rx) = sync_channel::<String>(8);
        let session = Arc::new(AtomicI32::new(0));
        let worker_session = session.clone();
        thread::Builder::new()
            .name("pocket-offload".into())
            .spawn(move || {
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    let mut handler = initialize();
                    worker_session.store(1, Ordering::Release);
                    while let Ok(record) = requests.recv() {
                        let reply = handler(&record);
                        if reply.len() > 4096 || replies.send(reply).is_err() {
                            break;
                        }
                    }
                }));
                worker_session.store(0, Ordering::Release);
                if result.is_err() {
                    log::error!("offload worker failed");
                }
            })
            .expect("offload worker spawn");
        Self {
            inner: Rc::new(Mailbox {
                tx,
                rx,
                session,
                credit: Arc::new(AtomicUsize::new(0)),
                delivered: Cell::new(false),
            }),
        }
    }
    pub fn begin_frame(&self) {
        self.inner.delivered.set(false);
    }
    pub fn mount(&self, guest: &Guest) -> Result<()> {
        guest.mount("offload", |ctx, ns| {
            let m = self.inner.clone();
            ns.set(
                "session",
                Function::new(ctx.clone(), move || m.session.load(Ordering::Acquire))?,
            )?;
            let m = self.inner.clone();
            ns.set(
                "submit",
                Function::new(ctx.clone(), move |record: String| {
                    if record.len() > 4096
                        || m.session.load(Ordering::Acquire) <= 0
                        || m.credit.load(Ordering::Acquire) >= 8
                    {
                        return false;
                    }
                    if m.tx.try_send(record).is_err() {
                        return false;
                    }
                    m.credit.fetch_add(1, Ordering::Release);
                    true
                })?,
            )?;
            let m = self.inner.clone();
            ns.set(
                "take",
                Function::new(ctx.clone(), move || -> Option<String> {
                    if m.delivered.replace(true) {
                        return None;
                    }
                    let record = m.rx.try_recv().ok()?;
                    m.credit.fetch_sub(1, Ordering::Release);
                    Some(record)
                })?,
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_nonwaiting_ops_and_worker_ownership() {
        let owner = thread::current().id();
        let worker = OffloadWorker::spawn(move || {
            assert_ne!(owner, thread::current().id());
            move |record: &str| {
                assert_ne!(owner, thread::current().id());
                record.to_owned()
            }
        });
        let guest = Guest::new().unwrap();
        worker.mount(&guest).unwrap();
        for _ in 0..100 {
            if worker.inner.session.load(Ordering::Acquire) > 0 {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(1));
        }
        guest.eval("queue", "if(offload.session()<=0)throw Error('not ready'); for(let i=0;i<8;i++)if(!offload.submit('test'))throw Error('no credit'); if(offload.submit('overflow'))throw Error('unbounded queue');").unwrap();
        thread::sleep(std::time::Duration::from_millis(20));
        worker.begin_frame();
        guest.eval("reply", "if(offload.take()!=='test')throw Error('no reply'); if(offload.take()!==undefined)throw Error('multiple deliveries');").unwrap();
    }
}
