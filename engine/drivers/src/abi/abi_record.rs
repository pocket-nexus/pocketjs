//! Shared implementation for generated C ABI records.
//!
//! The generator restricts fields to integers, floats, raw pointers, optional
//! `extern "C"` function pointers, and arrays of those types. Every field must
//! admit an all-zero representation and be `Copy`; `empty` relies on this.
//! This macro is private so it cannot be used as a general record constructor.

macro_rules! abi_record {
    (
        $(#[$record_doc:meta])*
        pub struct $name:ident {
            $(#[$prefix_doc:meta])*
            pub struct_size: usize,
            $($(#[$field_doc:meta])* pub $field:ident: $ty:ty,)*
        }
    ) => {
        $(#[$record_doc])*
        #[repr(C)]
        #[derive(Clone, Copy, Debug)]
        pub struct $name {
            $(#[$prefix_doc])*
            pub struct_size: usize,
            $($(#[$field_doc])* pub $field: $ty,)*
        }

        impl $name {
            /// An empty current-version record suitable for an output callback.
            pub fn empty() -> Self {
                // All field types in the ABI vocabulary admit zero (see above).
                let mut value: Self = unsafe { core::mem::zeroed() };
                value.struct_size = core::mem::size_of::<Self>();
                value
            }

            /// Copy only complete fields; absent fields remain zero/null.
            /// # Safety
            /// A nonnull pointer provides a readable usize prefix and valid field
            /// representations through min(struct_size, known size). No full-sized
            /// reference is formed from a possibly shorter caller allocation.
            pub unsafe fn read_prefix(pointer: *const Self) -> Option<Self> {
                if pointer.is_null() {
                    return None;
                }
                let bytes = pointer.cast::<u8>();
                let capacity = unsafe { bytes.cast::<usize>().read_unaligned() };
                if capacity < core::mem::size_of::<usize>() || capacity > isize::MAX as usize {
                    return None;
                }
                let mut value = Self::empty();
                value.struct_size = capacity;
                $(
                    let offset = core::mem::offset_of!(Self, $field);
                    if offset + core::mem::size_of::<$ty>() <= capacity {
                        value.$field = unsafe { bytes.add(offset).cast::<$ty>().read_unaligned() };
                    }
                )*
                Some(value)
            }

            /// Preserve the caller's capacity and write only complete known fields.
            /// # Safety
            /// pointer provides a readable usize prefix and writable bytes through
            /// min(struct_size, known size), with no overlapping live references.
            pub unsafe fn write_prefix(self, pointer: *mut Self) -> bool {
                if pointer.is_null() {
                    return false;
                }
                let bytes = pointer.cast::<u8>();
                let capacity = unsafe { bytes.cast::<usize>().read_unaligned() };
                if capacity < core::mem::size_of::<usize>() || capacity > isize::MAX as usize {
                    return false;
                }
                $(
                    let offset = core::mem::offset_of!(Self, $field);
                    if offset + core::mem::size_of::<$ty>() <= capacity {
                        unsafe { bytes.add(offset).cast::<$ty>().write_unaligned(self.$field) };
                    }
                )*
                true
            }
        }

        // Compute C layout from declaration order and target field alignment,
        // then compare it with the compiler's record layout. Do not derive the
        // expected offsets from offset_of!: that would make the check tautological.
        const _: () = {
            assert!(core::mem::offset_of!($name, struct_size) == 0);
            let mut size = core::mem::size_of::<usize>();
            let mut align = core::mem::align_of::<usize>();
            $(
                let field_align = core::mem::align_of::<$ty>();
                size = size.div_ceil(field_align) * field_align;
                assert!(core::mem::offset_of!($name, $field) == size);
                size += core::mem::size_of::<$ty>();
                if field_align > align {
                    align = field_align;
                }
            )*
            assert!(core::mem::size_of::<$name>() == size.div_ceil(align) * align);
            assert!(core::mem::align_of::<$name>() == align);
        };
    };
}

pub(super) use abi_record;
