# AgentPersonaScreen Object

* `width` Integer
* `height` Integer
* `availWidth` Integer
* `availHeight` Integer
* `colorDepth` Integer - `screen.colorDepth`. CSS `color` uses the matching bits per component: 48 becomes 16, 30 becomes 10, 16 becomes 5, and 32, 24, and 8 become 8.
* `deviceScaleFactor` Double - `window.devicePixelRatio` and `matchMedia` `resolution`. Layout keeps the real scale.
