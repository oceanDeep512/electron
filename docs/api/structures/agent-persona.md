# AgentPersona Object

* `seed` string
* `userAgent` string
* `userAgentMetadata` Object
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
* `acceptLanguages` string[]
* `timezone` string - IANA time zone id.
* `hardwareConcurrency` Integer - From 1 to 1024.
* `deviceMemory` Double - One of `0.25`, `0.5`, `1`, `2`, `4`, `8`, `16`, `32`, `64`.
* `screen` [AgentPersonaScreen](structures/agent-persona-screen.md) (optional) - `screen` metrics and `window.devicePixelRatio`. Omitted leaves the real screen.
* `webgl` [AgentPersonaWebGL](structures/agent-persona-webgl.md) (optional) - Vendor and renderer strings returned by WebGL. Omitted leaves Chromium's strings.
* `webgpu` [AgentPersonaWebGPU](structures/agent-persona-webgpu.md) (optional) - Adapter identity strings. Omitted leaves the real adapter. Limits are not changed.
* `webrtcIpHandlingPolicy` string (optional) - `default`, `default_public_interface_only`, `default_public_and_private_interfaces`, or `disable_non_proxied_udp`. Omitted means `default`, which leaves Chromium's policy.
* `fontPolicy` string (optional) - `real` or `core`. Omitted means `real`. `core` limits named font matching, `local()`, `document.fonts.check`, and `queryLocalFonts` to Arial, Courier New, Georgia, Times New Roman, Trebuchet MS, and Verdana. CSS generic families still use the platform font. Those six families use the host face when it is installed, so their widths can differ by operating system. No font files are bundled.
