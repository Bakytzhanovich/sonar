# RNNoise model

`bd.rnnn` — the "beguiling-drafter" RNNoise model, used by ffmpeg's `arnndn`
filter to strip background noise (street, wind, room tone) from speech.

Source: https://github.com/GregorR/rnnoise-models (beguiling-drafter-2018-08-30)

## Why this model

All five published models were measured against a real client clip (outdoor
selfie video, heavy wind) — noise floor taken from a speech-free pause,
speech level from a peak:

| model | noise | speech peak | net SNR gain |
|-------|-------|-------------|--------------|
| none  | -18.4 | -2.8        | —            |
| cb    | -27.7 | -7.2        | 4.9 dB       |
| mp    | -29.5 | -6.8        | 7.1 dB       |
| lq    | -32.1 | -7.5        | 9.0 dB       |
| sh    | -34.1 | -8.1        | 10.4 dB      |
| bd    | -37.1 | -9.5        | **12.0 dB**  |

`bd` suppresses the most noise per dB of speech it costs. It does attenuate
speech more in absolute terms, so the render chain applies a fixed +7 dB after
the filter (with a limiter for the peaks).

That gain is deliberately NOT speechnorm/loudnorm: those raise quiet passages,
i.e. the pauses, i.e. the leftover noise. Measured on the same clip, speechnorm
pulled the noise floor from -37 dB back to -20 dB, ending up worse than the
weakest model. Final chain measured: noise -29.6 dB, speech peak -2.1 dB —
27.5 dB SNR, against 15.6 dB untouched.

Committed rather than downloaded at build time: it is under 300 KB, and a
build that reaches out to GitHub fails whenever that host does.

RNNoise is trained at 48 kHz. The render graph resamples to 48 kHz before the
filter — feeding it 16 kHz audio measurably weakens the result.
