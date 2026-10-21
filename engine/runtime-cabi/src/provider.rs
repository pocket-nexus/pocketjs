use crate::adapters::{borrowed, AdapterError};
use alloc::vec::Vec;
use core::{ffi::c_void, mem};
use pocket_drivers::abi::*;
use pocket_runtime::{generated_ops, OpArg, OpProvider, OpResult, RuntimeError};
use pocketjs_core::Ui;

pub(crate) struct COpProvider {
    dispatch: PocketOpProviderDispatchFn,
    context: *mut c_void,
    operations: Vec<u16>,
}
impl COpProvider {
    /// The caller retains context and callback storage through runtime destruction.
    pub(crate) unsafe fn new(
        table: *const PocketOpProviderV1,
        context: *mut c_void,
        operations: *const u16,
        count: usize,
    ) -> Result<Self, AdapterError> {
        let table =
            unsafe { PocketOpProviderV1::read_prefix(table) }.ok_or(AdapterError::Invalid)?;
        let dispatch = table.dispatch.ok_or(AdapterError::Invalid)?;
        let mut operations = unsafe { borrowed(operations, count) }?.to_vec();
        operations.sort_unstable();
        if operations.is_empty()
            || operations.windows(2).any(|pair| pair[0] == pair[1])
            || operations.iter().any(|&op| {
                generated_ops::descriptor(op)
                    .is_none_or(|op| matches!(op.provider, "core" | "package"))
            })
        {
            return Err(AdapterError::Invalid);
        }
        Ok(Self {
            dispatch,
            context,
            operations,
        })
    }
}
impl OpProvider for COpProvider {
    fn supports_op(&self, op: u16) -> bool {
        self.operations.binary_search(&op).is_ok()
    }
    fn dispatch(
        &mut self,
        _: &mut Ui,
        op: u16,
        arguments: &[OpArg<'_>],
    ) -> Result<OpResult, RuntimeError> {
        let arguments: Vec<_> = arguments
            .iter()
            .map(|arg| {
                let mut value = PocketOpArg::empty();
                match arg {
                    OpArg::Integer(integer) => {
                        value.tag = POCKET_ARG_INTEGER;
                        value.integer = *integer;
                    }
                    OpArg::Real(real) => {
                        value.tag = POCKET_ARG_REAL;
                        value.real = *real;
                    }
                    OpArg::Bytes(bytes) => {
                        value.tag = POCKET_ARG_BYTES;
                        value.bytes = bytes.as_ptr();
                        value.byte_length = bytes.len();
                    }
                }
                value
            })
            .collect();
        let mut output = PocketResult::empty();
        let status = unsafe {
            (self.dispatch)(
                self.context,
                op,
                arguments.as_ptr(),
                arguments.len() * mem::size_of::<PocketOpArg>(),
                &mut output,
            )
        };
        match status {
            POCKET_STATUS_OK => {}
            POCKET_STATUS_UNSUPPORTED => return Err(RuntimeError::UnsupportedOperation),
            POCKET_STATUS_INVALID => return Err(RuntimeError::InvalidArgument),
            _ => return Err(RuntimeError::InvalidState),
        }
        // The callback receives a current-size output, but may produce an older
        // prefix. Read only complete fields announced by that prefix.
        if output.struct_size > mem::size_of::<PocketResult>() {
            return Err(RuntimeError::InvalidArgument);
        }
        let size = output.struct_size;
        let output =
            unsafe { PocketResult::read_prefix(&output) }.ok_or(RuntimeError::InvalidArgument)?;
        let result = match output.tag {
            POCKET_RESULT_NONE
                if size >= mem::offset_of!(PocketResult, tag) + mem::size_of::<u32>() =>
            {
                OpResult::None
            }
            POCKET_RESULT_I64
                if size >= mem::offset_of!(PocketResult, integer) + mem::size_of::<i64>() =>
            {
                OpResult::Integer(output.integer)
            }
            POCKET_RESULT_F64
                if size >= mem::offset_of!(PocketResult, real) + mem::size_of::<f64>() =>
            {
                OpResult::Real(output.real)
            }
            POCKET_RESULT_BYTES
                if size >= mem::offset_of!(PocketResult, byte_length) + mem::size_of::<usize>() =>
            {
                let bytes = unsafe { borrowed(output.bytes, output.byte_length) }
                    .map_err(|_| RuntimeError::InvalidArgument)?;
                OpResult::Bytes(bytes.to_vec())
            }
            _ => return Err(RuntimeError::InvalidArgument),
        };
        Ok(result)
    }
}
