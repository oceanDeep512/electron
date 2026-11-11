# AccessibilityTreeNode Object

* `id` Integer
* `role` string - `ui::ToString` of the Chromium accessibility role.
* `name` string - The `kName` string attribute, or an empty string.
* `childIds` Integer[] - Child ids in the combined tree. Chromium's `AXTreeCombiner` appends a child-tree root when that tree's `parent_tree_id` matches.
* `ignored` boolean
* `bounds` Object - `AXRelativeBounds.bounds`. Not a screen rect and not widget DIP.
  * `x` number
  * `y` number
  * `width` number
  * `height` number
* `offsetContainerId` Integer - `0` when there is no offset container.
* `hasTransform` boolean - `true` when the node has an `AXRelativeBounds` transform. This object does not flatten transforms.
