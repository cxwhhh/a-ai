"use client";

import { Menu } from "@base-ui/react/menu";
import { cx } from "../../utils/cx";
import { ICheck } from "../Icons";

// 来自 shadcn/ui Base Nova 注册表，使用 A.ai 的菜单样式、图标和主题变量。
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuLabel = Menu.GroupLabel;
export const DropdownMenuItem = Menu.Item;
export const DropdownMenuFilterProvider = Menu.FilterProvider;
export const DropdownMenuInput = Menu.Input;
export const DropdownMenuList = Menu.List;
export const DropdownMenuRadioGroup = Menu.RadioGroup;
export const DropdownMenuSeparator = Menu.Separator;

export function DropdownMenuContent({
  align = "start",
  side = "bottom",
  sideOffset = 4,
  portalContainer,
  className,
  ...props
}: Menu.Popup.Props & Pick<Menu.Positioner.Props, "align" | "side" | "sideOffset"> & { className?: string; portalContainer?: Menu.Portal.Props["container"] }) {
  return (
    <Menu.Portal container={portalContainer}>
      <Menu.Positioner className="prompt-menu-positioner" align={align} side={side} sideOffset={sideOffset}>
        <Menu.Popup data-slot="dropdown-menu-content" className={cx("prompt-menu", className)} {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  );
}

export function DropdownMenuRadioItem({ children, ...props }: Menu.RadioItem.Props) {
  return (
    <Menu.RadioItem data-slot="dropdown-menu-radio-item" {...props}>
      {children}
      <Menu.RadioItemIndicator className="prompt-menu-check">
        <ICheck width={15} height={15} aria-hidden />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}
