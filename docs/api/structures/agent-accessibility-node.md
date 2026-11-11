# AgentAccessibilityNode Object

* `id` Integer
* `role` string
* `name` string
* `parentId` Integer | null - First parent derived by inverting `childIds`.
* `childIds` Integer[]
* `ignored` boolean
* `relativeBounds` Object
  * `x` number
  * `y` number
  * `width` number
  * `height` number
* `offsetContainerId` Integer
* `hasTransform` boolean
* `boundsSpace` string - `offset-container`, `tree-root`, or `containing-node`.
* `resolvedBounds` Object | null - Sum of relative bounds along the offset chain when no transform is present. Null when a transform or a cycle blocks the walk. Not a screen coordinate and not widget DIP.
  * `x` number
  * `y` number
  * `width` number
  * `height` number
