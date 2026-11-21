use pocketjs_core::Ui;

#[cfg(not(feature = "runtime"))]
pub type CoreRead<'a> = &'a Ui;
#[cfg(not(feature = "runtime"))]
pub type CoreWrite<'a> = &'a mut Ui;

pub(crate) enum CoreHandle {
    #[cfg(not(feature = "runtime"))]
    Owned(Ui),
    #[cfg(feature = "runtime")]
    Owned(alloc::boxed::Box<Ui>),
    #[cfg(feature = "runtime")]
    Runtime(pocket_runtime::OpContext),
}
impl CoreHandle {
    pub fn owned(ui: Ui) -> Self {
        #[cfg(not(feature = "runtime"))]
        {
            Self::Owned(ui)
        }
        #[cfg(feature = "runtime")]
        {
            Self::Owned(alloc::boxed::Box::new(ui))
        }
    }
    #[cfg(feature = "runtime")]
    pub fn runtime(ops: pocket_runtime::OpContext) -> Self {
        Self::Runtime(ops)
    }
    pub fn runtime_owned(&self) -> bool {
        match self {
            Self::Owned(_) => false,
            #[cfg(feature = "runtime")]
            Self::Runtime(_) => true,
        }
    }
    pub fn into_owned(self) -> Ui {
        match self {
            #[cfg(not(feature = "runtime"))]
            Self::Owned(ui) => ui,
            #[cfg(feature = "runtime")]
            Self::Owned(ui) => *ui,
            #[cfg(feature = "runtime")]
            Self::Runtime(_) => panic!("an AOT guest cannot detach the runtime's core"),
        }
    }
    #[cfg(not(feature = "runtime"))]
    pub fn read(&self) -> CoreRead<'_> {
        let Self::Owned(ui) = self;
        ui
    }
    #[cfg(not(feature = "runtime"))]
    pub fn write(&mut self) -> CoreWrite<'_> {
        let Self::Owned(ui) = self;
        ui
    }
    #[cfg(feature = "runtime")]
    pub fn read(&self) -> CoreRead<'_> {
        match self {
            Self::Owned(ui) => CoreRead::Owned(ui),
            Self::Runtime(ops) => CoreRead::Runtime(ops.core().expect("active AOT core")),
        }
    }
    #[cfg(feature = "runtime")]
    pub fn write(&mut self) -> CoreWrite<'_> {
        match self {
            Self::Owned(ui) => CoreWrite::Owned(ui),
            Self::Runtime(ops) => CoreWrite::Runtime(ops.core_mut().expect("exclusive AOT core")),
        }
    }
}
#[cfg(feature = "runtime")]
pub enum CoreRead<'a> {
    Owned(&'a Ui),
    Runtime(core::cell::Ref<'a, pocket_runtime::CoreState>),
}
#[cfg(feature = "runtime")]
impl core::ops::Deref for CoreRead<'_> {
    type Target = Ui;
    fn deref(&self) -> &Ui {
        match self {
            Self::Owned(ui) => ui,
            Self::Runtime(state) => &state.ui,
        }
    }
}
#[cfg(feature = "runtime")]
pub enum CoreWrite<'a> {
    Owned(&'a mut Ui),
    Runtime(core::cell::RefMut<'a, pocket_runtime::CoreState>),
}
#[cfg(feature = "runtime")]
impl core::ops::Deref for CoreWrite<'_> {
    type Target = Ui;
    fn deref(&self) -> &Ui {
        match self {
            Self::Owned(ui) => ui,
            Self::Runtime(state) => &state.ui,
        }
    }
}
#[cfg(feature = "runtime")]
impl core::ops::DerefMut for CoreWrite<'_> {
    fn deref_mut(&mut self) -> &mut Ui {
        match self {
            Self::Owned(ui) => ui,
            Self::Runtime(state) => {
                state.mutated();
                &mut state.ui
            }
        }
    }
}
