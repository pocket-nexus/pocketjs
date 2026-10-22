#ifndef POCKETJS_SYMBIAN_KEYS_H
#define POCKETJS_SYMBIAN_KEYS_H

/*
 * Qt 4.7's Symbian backend forwards ordinary character keysyms directly.
 * The E7 therefore reports an unshifted physical W as 'w', while Qt::Key_W
 * is the uppercase ASCII value. Keep semantic game controls independent of
 * Shift and Caps Lock without changing punctuation or platform control keys.
 */
#define POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY(key) \
    (((key) >= 'a' && (key) <= 'z') ? ((key) - ('a' - 'A')) : (key))

/*
 * The E7/RM-626 keyboard matrix exposes its Q-P row through scan codes 1-0;
 * the same physical keys produce Q-P normally and those digits through Fn.
 * Its remaining letter keys use A-Z scan codes. Resolve that target-specific
 * physical layout before the FEP-dependent logical key, but never reinterpret
 * a logical digit when native scan information is absent.
 */
#define POCKETJS_SYMBIAN_IS_PHYSICAL_LETTER_SCAN_CODE(key) \
    ((key) >= 'A' && (key) <= 'Z')

static inline int pocketjsSymbianNormalizeKey(int key)
{
    return POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY(key);
}

static inline int pocketjsSymbianE7PhysicalKey(unsigned int nativeScanCode)
{
    switch (nativeScanCode) {
    case '1': return 'Q';
    case '2': return 'W';
    case '3': return 'E';
    case '4': return 'R';
    case '5': return 'T';
    case '6': return 'Y';
    case '7': return 'U';
    case '8': return 'I';
    case '9': return 'O';
    case '0': return 'P';
    default: break;
    }
    if (POCKETJS_SYMBIAN_IS_PHYSICAL_LETTER_SCAN_CODE(nativeScanCode)) {
        return (int)nativeScanCode;
    }
    return 0;
}

static inline int pocketjsSymbianControlKey(
    int key,
    unsigned int nativeScanCode
)
{
    const int physicalKey =
        pocketjsSymbianE7PhysicalKey(nativeScanCode);
    return physicalKey != 0
        ? physicalKey
        : pocketjsSymbianNormalizeKey(key);
}

#endif
