/// <reference path="./phosphor.d.ts" />
// Icons: Phosphor (phosphoricons.com), regular weight unless asked, in the text's colour. The ones the app and its
// extensions use, by Phosphor's own names (ArchiveIcon); add one here, and to phosphor.d.ts, to use it. A few Phosphor
// lacks are drawn on its grid below.
import { forwardRef } from 'react'
import type { Icon as PhosphorIcon, IconWeight as Weight } from '@phosphor-icons/react'
import IconBase from '@phosphor-icons/react/dist/lib/IconBase'

export { ArchiveIcon } from '@phosphor-icons/react/dist/csr/Archive'
export { ArrowsLeftRightIcon } from '@phosphor-icons/react/dist/csr/ArrowsLeftRight'
export { ArrowUpIcon } from '@phosphor-icons/react/dist/csr/ArrowUp'
export { CardsIcon } from '@phosphor-icons/react/dist/csr/Cards'
export { ChatsIcon } from '@phosphor-icons/react/dist/csr/Chats'
export { ColumnsIcon } from '@phosphor-icons/react/dist/csr/Columns'
export { ColumnsPlusRightIcon } from '@phosphor-icons/react/dist/csr/ColumnsPlusRight'
export { ArrowsOutLineHorizontalIcon } from '@phosphor-icons/react/dist/csr/ArrowsOutLineHorizontal'
export { DeviceMobileIcon } from '@phosphor-icons/react/dist/csr/DeviceMobile'
export { DeviceTabletIcon } from '@phosphor-icons/react/dist/csr/DeviceTablet'
export { LaptopIcon } from '@phosphor-icons/react/dist/csr/Laptop'
export { ResizeIcon } from '@phosphor-icons/react/dist/csr/Resize'
export { GlobeIcon } from '@phosphor-icons/react/dist/csr/Globe'
export { IdentificationBadgeIcon } from '@phosphor-icons/react/dist/csr/IdentificationBadge'
export { KeyIcon } from '@phosphor-icons/react/dist/csr/Key'
export { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning'
export { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning'
export { ChatTextIcon } from '@phosphor-icons/react/dist/csr/ChatText'
export { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise'
export { ArrowCircleUpIcon } from '@phosphor-icons/react/dist/csr/ArrowCircleUp'
export { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise'
export { ArrowDownIcon } from '@phosphor-icons/react/dist/csr/ArrowDown'
export { ArrowElbowDownRightIcon } from '@phosphor-icons/react/dist/csr/ArrowElbowDownRight'
export { ArrowElbowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowElbowRight'
export { ArrowLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowLeft'
export { ArrowRightIcon } from '@phosphor-icons/react/dist/csr/ArrowRight'
export { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut'
export { BellIcon } from '@phosphor-icons/react/dist/csr/Bell'
export { BroomIcon } from '@phosphor-icons/react/dist/csr/Broom'
export { PlugsConnectedIcon } from '@phosphor-icons/react/dist/csr/PlugsConnected'
export { PlugIcon } from '@phosphor-icons/react/dist/csr/Plug'
export { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown'
export { CaretLeftIcon } from '@phosphor-icons/react/dist/csr/CaretLeft'
export { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight'
export { ChatCircleIcon } from '@phosphor-icons/react/dist/csr/ChatCircle'
export { ChatsCircleIcon } from '@phosphor-icons/react/dist/csr/ChatsCircle'
export { CheckIcon } from '@phosphor-icons/react/dist/csr/Check'
export { CornersInIcon } from '@phosphor-icons/react/dist/csr/CornersIn'
export { CornersOutIcon } from '@phosphor-icons/react/dist/csr/CornersOut'
export { CopyIcon } from '@phosphor-icons/react/dist/csr/Copy'
export { CursorClickIcon } from '@phosphor-icons/react/dist/csr/CursorClick'
export { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree'
export { FileIcon } from '@phosphor-icons/react/dist/csr/File'
export { ImageBrokenIcon } from '@phosphor-icons/react/dist/csr/ImageBroken'
export { FilePlusIcon } from '@phosphor-icons/react/dist/csr/FilePlus'
export { FileTextIcon } from '@phosphor-icons/react/dist/csr/FileText'
export { FolderSimpleIcon } from '@phosphor-icons/react/dist/csr/FolderSimple'
export { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix'
export { GitBranchIcon } from '@phosphor-icons/react/dist/csr/GitBranch'
export { LifebuoyIcon } from '@phosphor-icons/react/dist/csr/Lifebuoy'
export { ListIcon } from '@phosphor-icons/react/dist/csr/List'
export { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass'
export { MagnifyingGlassMinusIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlassMinus'
export { MagnifyingGlassPlusIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlassPlus'
export { MinusIcon } from '@phosphor-icons/react/dist/csr/Minus'
export { NotePencilIcon } from '@phosphor-icons/react/dist/csr/NotePencil'
export { PaperclipIcon } from '@phosphor-icons/react/dist/csr/Paperclip'
export { PauseIcon } from '@phosphor-icons/react/dist/csr/Pause'
export { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple'
export { PlusIcon } from '@phosphor-icons/react/dist/csr/Plus'
export { StarIcon } from '@phosphor-icons/react/dist/csr/Star'
export { DotsSixVerticalIcon } from '@phosphor-icons/react/dist/csr/DotsSixVertical'
export { PushPinIcon } from '@phosphor-icons/react/dist/csr/PushPin'
export { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle'
export { SquareSplitHorizontalIcon } from '@phosphor-icons/react/dist/csr/SquareSplitHorizontal'
export { TableIcon } from '@phosphor-icons/react/dist/csr/Table'
export { StopIcon } from '@phosphor-icons/react/dist/csr/Stop'
export { TerminalIcon } from '@phosphor-icons/react/dist/csr/Terminal'
export { WrenchIcon } from '@phosphor-icons/react/dist/csr/Wrench'
export { XIcon } from '@phosphor-icons/react/dist/csr/X'
export type { Icon, IconProps, IconWeight } from '@phosphor-icons/react'

/**
 * Open a pane beside: a window split in two, a plus in the new half. Phosphor's ColumnsPlusRight is the layout switch's,
 * so this one is drawn on its grid, from SquareSplitHorizontal's lines; one weight, regular, whatever is asked.
 */
const panePlus = (
  <>
    <path d="M216,40H40A16,16,0,0,0,24,56V200a16,16,0,0,0,16,16H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40ZM40,56h72V200H40ZM216,200H128V56h88Z" />
    <path d="M164,104v16H148a8,8,0,0,0,0,16h16v16a8,8,0,0,0,16,0V136h16a8,8,0,0,0,0-16H180V104a8,8,0,0,0-16,0Z" />
  </>
)
const panePlusWeights = new Map<Weight, typeof panePlus>((['thin', 'light', 'regular', 'bold', 'fill', 'duotone'] as const).map((w) => [w, panePlus]))
export const PanePlusIcon: PhosphorIcon = forwardRef((props, ref) => <IconBase ref={ref} {...props} weights={panePlusWeights} />)
PanePlusIcon.displayName = 'PanePlusIcon'
