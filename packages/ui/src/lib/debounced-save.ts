import { useRef } from "react";

/** 把窗口内各字段的编辑合并，逐批提交，旧请求的返回值不能覆盖新输入。 */
export function useDebouncedSave<P extends object, R>(
  write: (patch: Partial<P>) => Promise<R>,
  onSaved: (result: R) => void,
  onError: (error: unknown) => void,
) {
  const pending = useRef<Partial<P>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sequence = useRef(0);
  const settled = useRef(0);
  const tail = useRef<Promise<unknown>>(Promise.resolve());

  const flush = () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    const version = sequence.current;
    const request = tail.current.then(() => write(patch));
    tail.current = request.then((result) => {
      settled.current = version;
      if (version === sequence.current) onSaved(result);
    }, (error) => {
      settled.current = version;
      onError(error);
    });
    return request;
  };

  const stage = (patch: Partial<P>) => {
    Object.assign(pending.current, patch);
    sequence.current++;
  };

  return {
    busy: () => settled.current !== sequence.current,
    schedule(patch: Partial<P>, delay: number) {
      stage(patch);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => { void flush(); }, delay);
    },
    save(patch: Partial<P>) {
      stage(patch);
      return flush();
    },
  };
}
