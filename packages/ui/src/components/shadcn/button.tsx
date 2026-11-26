"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import type { ComponentProps } from "react";

/** shadcn Base Nova 的按钮部件，视觉样式由使用它的区域指定。 */
export function Button({ type = "button", ...props }: ComponentProps<typeof ButtonPrimitive>) {
  return <ButtonPrimitive type={type} data-slot="button" {...props} />;
}
