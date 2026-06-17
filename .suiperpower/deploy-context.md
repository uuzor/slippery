## Deploy, 2026-06-17

### Network
- env: testnet
- rpc: `https://fullnode.testnet.sui.io:443`
- gas address: `0xb70bf0752c3f349b65054d9428bc95caebadbbf86b57c873ad5d06cd8029dd2d`
- balance before: `1.40 SUI`, `450.00 DUSDC`
- balance after: `1.10 SUI`, `48.73 DUSDC`

### Package
- package id: `0xc4874d9d95044d9e1658211fbccc4cd36982628b28d3056c02b41eb6f488bca4`
- modules: `parlay_vault`, `slip_executor`, `slip_pricer`
- digest: `HMVmphUd1upsiCQd7Zv5kDFzsfAP5LckBVvK7nMnfMXn`
- upgrade cap object: `0x110fa2e1c67c94206df38772586186db02caca9b6e487d9b82f45f241f45ca29`
- upgrade cap policy: `compatible`

### Notes
- This upgrade adds `seed_liquidity` for immediate LP bootstrap and `place_slip_bcs` for keeper/frontend-friendly slip placement.
- Shared runtime objects remained unchanged: vault `0xc5b7d6189e77c87381a0a80ab7826ec2cb3ff9f15c904ac7d1a3885a2f4aa0f1`, open slips `0xe0411a8957e3e72e9408086652b891e49a49f38a70e5eb2160f4a7656f019930`.
- Predict manager used in the live smoke flow: `0x65f26499d13a3bde34a703dad2782d13b55b2aec650a9a7115fe94e6adfdea47`.
- End-to-end smoke digests:
- seed `3xfRMFzWYWAv6Y6VmhSBpaK35zGTjwqL9gkp8mWiPFWf`
- place `Gsm41p1j5N1pr8Wyb5WeicPPtP7A3ww68kbf2iduJjaq`
- execute `EErtyakuiJKXmuNzQ2eXroYzno9BumS328jaAzSJkqBY`
- redeem `5EomfKSXSGCzmSP7PWNboc4pn1T3BRG3kBvSHbTp3mNE`
- settle `D6LJh6WbehYU7WvDk2eGD1LieyKiG1NzSn9XQmWkGNrK`
