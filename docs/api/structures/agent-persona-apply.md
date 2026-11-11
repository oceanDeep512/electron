# AgentPersonaApply Object

* `id` string - Canonical persona identity. A second call with the same id is a no-op. A different id throws.
* `seed` string - Seed for canvas and audio readback. The same seed and the same content produce the same perturbation.
* `userAgent` string
* `acceptLanguages` string - Comma-separated language tags.
* `timezone` string - IANA id checked with ICU. The browser-process default zone is not changed.
* `hardwareConcurrency` Integer
* `deviceMemory` Double - One of `0.25`, `0.5`, `1`, `2`, `4`, `8`, `16`, `32`, `64`.
* `brands` Object[]
  * `brand` string
  * `version` string
* `fullVersionList` Object[]
  * `brand` string
  * `version` string
* `fullVersion` string
* `platform` string
* `platformVersion` string
* `architecture` string
* `bitness` string
* `model` string
* `mobile` boolean
* `wow64` boolean
* `formFactors` string[]
* `screen` [AgentPersonaScreen](structures/agent-persona-screen.md) (optional)
* `webgl` [AgentPersonaWebGL](structures/agent-persona-webgl.md) (optional)
* `webgpu` [AgentPersonaWebGPU](structures/agent-persona-webgpu.md) (optional)
* `webrtcIpHandlingPolicy` string (optional) - `default` leaves Chromium's policy. Any other accepted policy is stored for every page in this partition.
