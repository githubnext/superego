// Phosphor's own types don't load under nodenext (its .d.ts files import each other without extensions, in an ES
// module package), so these stand in for the icons icons.tsx re-exports. Same shapes as its lib/types.d.ts. Each icon
// comes from a module of its own: Phosphor's index loads all 1,500, which Node (the SDK's test runner, vitest) does.
declare module '@phosphor-icons/react' {
  import type { ComponentPropsWithoutRef, ForwardRefExoticComponent, RefAttributes } from 'react'
  /** How heavy an icon's strokes are. */
  export type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone'
  /** What every icon takes: `size` (px, or a CSS length), `weight`, `color`, and an svg's own props. */
  export interface IconProps extends ComponentPropsWithoutRef<'svg'>, RefAttributes<SVGSVGElement> {
    alt?: string
    color?: string
    size?: string | number
    weight?: IconWeight
    mirrored?: boolean
  }
  /** An icon: a component drawing one of Phosphor's glyphs (`<XIcon size={12} />`). */
  export type Icon = ForwardRefExoticComponent<IconProps>
}

/** What every icon draws with: its glyph at each weight (`weights`), sized and coloured as the props say. */
declare module '@phosphor-icons/react/dist/lib/IconBase' {
  import type { ForwardRefExoticComponent, ReactElement, RefAttributes } from 'react'
  import type { IconProps, IconWeight } from '@phosphor-icons/react'
  const IconBase: ForwardRefExoticComponent<Omit<IconProps, 'ref'> & { weights: Map<IconWeight, ReactElement> } & RefAttributes<SVGSVGElement>>
  export default IconBase
}

declare module '@phosphor-icons/react/dist/csr/Archive' { export const ArchiveIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowClockwise' { export const ArrowClockwiseIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowCircleUp' { export const ArrowCircleUpIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowSquareOut' { export const ArrowSquareOutIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowCounterClockwise' { export const ArrowCounterClockwiseIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowDown' { export const ArrowDownIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowElbowDownRight' { export const ArrowElbowDownRightIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowElbowRight' { export const ArrowElbowRightIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowLeft' { export const ArrowLeftIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowRight' { export const ArrowRightIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowUp' { export const ArrowUpIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowsLeftRight' { export const ArrowsLeftRightIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Bell' { export const BellIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Broom' { export const BroomIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Cards' { export const CardsIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/CaretDown' { export const CaretDownIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/CaretLeft' { export const CaretLeftIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/CaretRight' { export const CaretRightIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ChatCircle' { export const ChatCircleIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ChatText' { export const ChatTextIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ChatsCircle' { export const ChatsCircleIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Chats' { export const ChatsIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/CursorClick' { export const CursorClickIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Check' { export const CheckIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Columns' { export const ColumnsIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ColumnsPlusRight' { export const ColumnsPlusRightIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Copy' { export const CopyIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/CornersIn' { export const CornersInIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/CornersOut' { export const CornersOutIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/DotsThree' { export const DotsThreeIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/File' { export const FileIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/FilePlus' { export const FilePlusIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/FileText' { export const FileTextIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/FolderSimple' { export const FolderSimpleIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/GearSix' { export const GearSixIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/GitBranch' { export const GitBranchIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ArrowsOutLineHorizontal' { export const ArrowsOutLineHorizontalIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/DeviceMobile' { export const DeviceMobileIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/DeviceTablet' { export const DeviceTabletIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Laptop' { export const LaptopIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Resize' { export const ResizeIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Globe' { export const GlobeIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/IdentificationBadge' { export const IdentificationBadgeIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ImageBroken' { export const ImageBrokenIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Key' { export const KeyIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Lifebuoy' { export const LifebuoyIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/List' { export const ListIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/MagnifyingGlass' { export const MagnifyingGlassIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/MagnifyingGlassMinus' { export const MagnifyingGlassMinusIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/MagnifyingGlassPlus' { export const MagnifyingGlassPlusIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Minus' { export const MinusIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/NotePencil' { export const NotePencilIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Paperclip' { export const PaperclipIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Pause' { export const PauseIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/PencilSimple' { export const PencilSimpleIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/PushPin' { export const PushPinIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Plug' { export const PlugIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/PlugsConnected' { export const PlugsConnectedIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Plus' { export const PlusIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/ShieldWarning' { export const ShieldWarningIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Sparkle' { export const SparkleIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/SquareSplitHorizontal' { export const SquareSplitHorizontalIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Stop' { export const StopIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Table' { export const TableIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Terminal' { export const TerminalIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Warning' { export const WarningIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/Wrench' { export const WrenchIcon: import('@phosphor-icons/react').Icon }
declare module '@phosphor-icons/react/dist/csr/X' { export const XIcon: import('@phosphor-icons/react').Icon }
