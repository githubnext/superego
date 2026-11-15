// Phosphor's own types don't load under nodenext (its .d.ts files import each other without extensions, in an ES
// module package), so these stand in for the icons icons.tsx re-exports. Same shapes as its lib/types.d.ts.
declare module '@phosphor-icons/react' {
  import type { ComponentPropsWithoutRef, ForwardRefExoticComponent, RefAttributes } from 'react'
  export type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone'
  export interface IconProps extends ComponentPropsWithoutRef<'svg'>, RefAttributes<SVGSVGElement> {
    alt?: string
    color?: string
    size?: string | number
    weight?: IconWeight
    mirrored?: boolean
  }
  export type Icon = ForwardRefExoticComponent<IconProps>
  export const ArchiveIcon: Icon
  export const CardsIcon: Icon
  export const ColumnsPlusRightIcon: Icon
  export const ArrowCounterClockwiseIcon: Icon
  export const ArrowDownIcon: Icon
  export const ArrowElbowDownRightIcon: Icon
  export const ArrowElbowRightIcon: Icon
  export const ArrowLeftIcon: Icon
  export const ArrowRightIcon: Icon
  export const BellIcon: Icon
  export const BroomIcon: Icon
  export const CaretDownIcon: Icon
  export const CaretLeftIcon: Icon
  export const CaretRightIcon: Icon
  export const ChatCircleIcon: Icon
  export const ArrowsLeftRightIcon: Icon
  export const ArrowUpIcon: Icon
  export const ChatsIcon: Icon
  export const ColumnsIcon: Icon
  export const GlobeIcon: Icon
  export const ChatTextIcon: Icon
  export const ChatsCircleIcon: Icon
  export const CheckIcon: Icon
  export const CommandIcon: Icon
  export const CopyIcon: Icon
  export const DotsThreeIcon: Icon
  export const ExclamationMarkIcon: Icon
  export const FileIcon: Icon
  export const FilePlusIcon: Icon
  export const FileTextIcon: Icon
  export const FolderSimpleIcon: Icon
  export const GearSixIcon: Icon
  export const LifebuoyIcon: Icon
  export const ListIcon: Icon
  export const ImageBrokenIcon: Icon
  export const MagnifyingGlassIcon: Icon
  export const MagnifyingGlassMinusIcon: Icon
  export const MagnifyingGlassPlusIcon: Icon
  export const MinusIcon: Icon
  export const NotePencilIcon: Icon
  export const PaperclipIcon: Icon
  export const PauseIcon: Icon
  export const PencilSimpleIcon: Icon
  export const PlusIcon: Icon
  export const QuestionMarkIcon: Icon
  export const SidebarSimpleIcon: Icon
  export const SparkleIcon: Icon
  export const SquareSplitHorizontalIcon: Icon
  export const TableIcon: Icon
  export const StopIcon: Icon
  export const TerminalIcon: Icon
  export const WrenchIcon: Icon
  export const XIcon: Icon
}
