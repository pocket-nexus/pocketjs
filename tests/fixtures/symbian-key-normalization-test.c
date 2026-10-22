#include "../../programs/nokia-e7/runtime/pocketjs_symbian_keys.h"

#if POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY('w') != 'W'
#error unshifted W must normalize to Qt::Key_W
#endif

#if POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY('r') != 'R'
#error unshifted R must normalize to Qt::Key_R
#endif

#if POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY('A') != 'A'
#error uppercase letters must remain unchanged
#endif

#if POCKETJS_SYMBIAN_NORMALIZED_ASCII_KEY(0x01000013) != 0x01000013
#error Qt special keys must remain unchanged
#endif

int main(void)
{
    static const char scans[] = {
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'
    };
    static const char controls[] = {
        'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'
    };
    unsigned int index;

    for (index = 0; index < sizeof(scans) / sizeof(scans[0]); ++index) {
        if (pocketjsSymbianControlKey(
                scans[index],
                (unsigned int)scans[index]
            ) != controls[index]) {
            return 10 + (int)index;
        }
    }
    if (pocketjsSymbianControlKey('d', 'D') != 'D') return 21;
    if (pocketjsSymbianControlKey('r', 0) != 'R') return 22;
    if (pocketjsSymbianControlKey(0x01000013, 0x0000000e) !=
        0x01000013) return 23;
    if (pocketjsSymbianControlKey(0x01000013, 0x61) !=
        0x01000013) return 24;
    if (pocketjsSymbianControlKey(0x01000013, 0x79) !=
        0x01000013) return 25;
    if (pocketjsSymbianControlKey('2', 0) != '2') return 26;
    return 0;
}
