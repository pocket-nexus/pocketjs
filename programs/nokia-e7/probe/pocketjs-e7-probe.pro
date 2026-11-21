TEMPLATE = app
TARGET = PocketJsE7Probe
QT += core gui
CONFIG += release
CONFIG -= debug app_bundle

SOURCES += main.cpp

symbian {
    isEmpty(POCKETJS_SYMBIAN_UID): error(POCKETJS_SYMBIAN_UID is required)
    QMAKE_LINK = /toolchain/current/bin/symbian-gcce-link
    TARGET.UID3 = $$POCKETJS_SYMBIAN_UID
    TARGET.CAPABILITY = None
    TARGET.EPOCSTACKSIZE = 0x14000
    TARGET.EPOCHEAPSIZE = 0x20000 0x800000

    QMAKE_ELF2E32_FLAGS -= --compressionmethod bytepair
    QMAKE_ELF2E32_FLAGS += --compressionmethod inflate
}
