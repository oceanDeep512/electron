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
* `screen` [AgentPersonaScreen](structures/agent-persona-screen.md) (optional) - Not applied. Present values fail with `persona-surface-unavailable`.
* `webgl` Object (optional) - Not applied. Present values fail with `persona-surface-unavailable`.
  * `vendor` string
  * `renderer` string
* `webgpu` Object (optional) - Not applied. Present values fail with `persona-surface-unavailable`.
  * `vendor` string
  * `architecture` string
  * `device` string
  * `description` string
* `webrtcIpHandlingPolicy` string (optional) - `default`, `default_public_interface_only`, `default_public_and_private_interfaces`, or `disable_non_proxied_udp`. Omitted means `default`. Any other value fails with `persona-surface-unavailable`.
* `fontPolicy` string (optional) - `real` or `core`. Omitted means `real`. `core` fails with `font-policy-unavailable`.
