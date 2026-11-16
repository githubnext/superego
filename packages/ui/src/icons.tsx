/// <reference path="./phosphor.d.ts" />
// Icons: Phosphor (phosphoricons.com), regular weight unless asked, in the text's colour. The ones the app and its
// extensions use, by Phosphor's own names (ArchiveIcon); add one here, and to phosphor.d.ts, to use it. A few Phosphor
// lacks are drawn on its grid below.
import { forwardRef } from 'react'
import { IconBase, type Icon as PhosphorIcon, type IconWeight as Weight } from '@phosphor-icons/react'

export {
  ArchiveIcon,
  ArrowsLeftRightIcon,
  ArrowUpIcon,
  CardsIcon,
  ChatsIcon,
  ColumnsIcon,
  ColumnsPlusRightIcon,
  GlobeIcon,
  IdentificationBadgeIcon,
  KeyIcon,
  ShieldWarningIcon,
  WarningIcon,
  ChatTextIcon,
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowElbowDownRightIcon,
  ArrowElbowRightIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BellIcon,
  BroomIcon,
  PlugsConnectedIcon,
  PlugIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleIcon,
  ChatsCircleIcon,
  CheckIcon,
  CommandIcon,
  CornersInIcon,
  CornersOutIcon,
  CopyIcon,
  DotsThreeIcon,
  ExclamationMarkIcon,
  FileIcon,
  ImageBrokenIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GitBranchIcon,
  LifebuoyIcon,
  ListIcon,
  MagnifyingGlassIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  MinusIcon,
  NotePencilIcon,
  PaperclipIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlusIcon,
  QuestionMarkIcon,
  SidebarSimpleIcon,
  SparkleIcon,
  SquareSplitHorizontalIcon,
  TableIcon,
  StopIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  type Icon, type IconProps, type IconWeight,
} from '@phosphor-icons/react'

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
