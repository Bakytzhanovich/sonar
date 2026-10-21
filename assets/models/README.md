# Person matting model

`modnet.onnx` — MODNet portrait matting, the int8-quantized ONNX export
published as `Xenova/modnet` (`onnx/model_quantized.onnx`), 6.6 MB.
Upstream: https://github.com/ZHKKKe/MODNet, Apache-2.0 (`MODNet-LICENSE.txt`).

Used by `src/personMask.ts` for the "слово за человеком" option of the Тема
look: the keyword is drawn behind the speaker.

## Why this model

Measured on a real client clip (1024×576, one speaker against a wall), CPU,
two threads, input 512×288:

| model | ms/frame |
|-------|----------|
| fp32 (25 MB) | 143 |
| int8 (6.6 MB) | 88 |

The two masks were indistinguishable by eye; int8 it is. Not RVM (Robust
Video Matting): it is GPL-3.0, which would oblige us to publish Sonar.
