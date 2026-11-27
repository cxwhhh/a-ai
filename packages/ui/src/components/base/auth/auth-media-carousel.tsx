"use client";

import { useEffect, useState } from "react";
import { cx } from "../../../utils/cx";

const DESKTOP = "(min-width: 48rem)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export interface AuthMediaSlide {
  src: string;
  alt?: string;
}

/** 官方 AuthMediaCarousel 的本地适配。宽屏淡入淡出，减少动态效果时停在第一张。 */
export function AuthMediaCarousel({ slides, interval = 4800, className }: {
  slides: AuthMediaSlide[];
  interval?: number;
  className?: string;
}) {
  const [active, setActive] = useState(0);
  const [desktop, setDesktop] = useState(() => typeof window !== "undefined" && window.matchMedia(DESKTOP).matches);

  useEffect(() => {
    const viewport = window.matchMedia(DESKTOP);
    const motion = window.matchMedia(REDUCED_MOTION);
    let timer: number | undefined;
    const sync = () => {
      window.clearInterval(timer);
      setDesktop(viewport.matches);
      setActive(0);
      if (viewport.matches && !motion.matches && slides.length > 1) {
        timer = window.setInterval(() => setActive((index) => (index + 1) % slides.length), interval);
      }
    };
    sync();
    viewport.addEventListener("change", sync);
    motion.addEventListener("change", sync);
    return () => {
      window.clearInterval(timer);
      viewport.removeEventListener("change", sync);
      motion.removeEventListener("change", sync);
    };
  }, [interval, slides.length]);

  if (!desktop) return null;
  return (
    <div className={cx("absolute inset-0 overflow-hidden", className)}>
      {slides.map((slide, index) => (
        <img
          key={slide.src}
          src={slide.src}
          alt={slide.alt ?? ""}
          aria-hidden={!slide.alt || index !== active}
          data-active={index === active ? "" : undefined}
          decoding="async"
          loading={index === 0 ? "eager" : "lazy"}
          className="aai-auth-slide absolute inset-0 size-full object-cover"
        />
      ))}
      {slides.length > 1 && (
        <div className="absolute inset-x-0 bottom-4 flex justify-center gap-1.5" aria-hidden>
          {slides.map(({ src }, index) => (
            <span key={src} className={cx("h-1.5 rounded-full bg-text-white", index === active ? "w-5 opacity-90" : "w-1.5 opacity-45")} />
          ))}
        </div>
      )}
    </div>
  );
}
