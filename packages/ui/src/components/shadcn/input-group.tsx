"use client";

import type { ComponentProps } from "react";
import { Button } from "./button";

// 来自 shadcn/ui Base Nova 注册表，仅接入聊天输入框使用的部件。
export function InputGroup(props: ComponentProps<"div">) {
  return <div data-slot="input-group" role="group" {...props} />;
}

/** 点击工具栏空白处可回到输入区，按钮和菜单里的操作仍交给各自控件。 */
export function InputGroupAddon({ align = "block-end", ...props }: ComponentProps<"div"> & { align?: "block-end" }) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      role="group"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, [role='menu'], input")) return;
        event.currentTarget.parentElement?.querySelector("textarea")?.focus();
      }}
      {...props}
    />
  );
}

export function InputGroupButton({ type = "button", ...props }: ComponentProps<typeof Button>) {
  return <Button type={type} data-slot="input-group-button" {...props} />;
}

export function InputGroupTextarea(props: ComponentProps<"textarea">) {
  return <textarea data-slot="input-group-control" {...props} />;
}
