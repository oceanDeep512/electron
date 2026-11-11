# AgentPersonaScreen Object

* `width` Integer
* `height` Integer
* `availWidth` Integer
* `availHeight` Integer
* `colorDepth` Integer - `screen.colorDepth`. CSS `color` uses the matching bits per component: 48 becomes 16, 30 becomes 10, 16 becomes 5, and 32, 24, and 8 become 8.
* `deviceScaleFactor` Double - `window.devicePixelRatio` and `matchMedia` `resolution`. Layout keeps the real scale.
* `colorIndex` Integer (optional) - CSS `color-index`. Omitted leaves Blink's value of 0. Set to an integer from 0 to 65535 to claim a color lookup table of that size.
* `highDynamicRange` boolean (optional) - CSS `dynamic-range` and `video-dynamic-range`. Omitted leaves the display's HDR support. `true` makes `high` match. `false` makes `high` fail. `standard` still matches.
