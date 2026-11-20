// Base UI's parts, as they are: unstyled, for something drawn its own way. Reached as `BaseUI.X` from '@superego/ui',
// the one way into Base UI outside this package, so every popup shares one copy of it (an Autocomplete inside a Dialog
// layers and takes Escape only when both come from the same Base UI). What's styled or does more than Base UI's part
// (`Dialog`, `Switch`, `Slider`, `SegmentedControl`, `Menu`, …) is a component of ours, exported under its own name.
//
// - Autocomplete: an input with a list of suggestions it filters; the box is a combobox and its list a listbox.
// - Combobox: a button that opens a list to pick one from, with a search field in it (grouped, filtered by the caller).
// - Dialog: a modal's parts, for one that isn't a framed sheet with a header (the image lightbox).
// - Drawer: a panel from a screen's edge that follows a finger out (from its `SwipeArea`) and back, settles by how far
//   and how fast it went, and is a modal dialog while out. Styled from its data attributes and CSS variables.
// - Tabs: a list of tabs, one active, its panel shown; arrow keys move along the list. `data-active` on the tab.
// - RadioGroup and Radio, CheckboxGroup and Checkbox, ToggleGroup and Toggle: choices of one (radios), any (checkboxes)
//   or either (toggle buttons). Each group is one the arrow keys move through, and says what's picked with
//   `data-checked` (radio, checkbox) or `data-pressed` (toggle).
export { Autocomplete } from '@base-ui/react/autocomplete'
export { Combobox } from '@base-ui/react/combobox'
export { Dialog } from '@base-ui/react/dialog'
export { Drawer } from '@base-ui/react/drawer'
export { Tabs } from '@base-ui/react/tabs'
export { RadioGroup } from '@base-ui/react/radio-group'
export { Radio } from '@base-ui/react/radio'
export { CheckboxGroup } from '@base-ui/react/checkbox-group'
export { Checkbox } from '@base-ui/react/checkbox'
export { ToggleGroup } from '@base-ui/react/toggle-group'
export { Toggle } from '@base-ui/react/toggle'
