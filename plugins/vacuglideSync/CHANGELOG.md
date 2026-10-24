# VacuGlide Sync changelog

## 0.6.6 (2026-10-23)

- Fixed: Tighter/Looser and keep suction were reversed on the device. Tested on a real VacuGlide 2: the Autoblow API's `stroke-plus` valve tightens (air out, more suction) and `stroke-minus` loosens (air in), the opposite of the manual's reading. Tighter now opens `stroke-plus`, Looser opens `stroke-minus`, and Keep suction tops up with `stroke-plus` pulses.
