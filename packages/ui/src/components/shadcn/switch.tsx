"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cx } from "../../utils/cx";

/** shadcn Base Nova 的开关，用项目主题色表示开关状态。 */
export function Switch({ className, ...props }: SwitchPrimitive.Root.Props & { className?: string }) {
  return (
    <SwitchPrimitive.Root data-slot="switch" className={cx("shadcn-switch", className)} {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
