import {
  IDoc, ICalc, IChart, ICheck, IClock, ICode, IDownload, IFile,
  IFileEdit, IFolder, IGlobe, IInfo, ILayers, ISearch, ISpark, ITerminal, IThink, IWrench,
} from "./Icons";

/**
 * 图标说明“这是哪类操作”，加载动画说明“它是否仍在进行”，两者不能互相替代。
 * 所以这里始终渲染静态类型图标；Row 另行按真实状态显示动画，完成后图标仍保留。
 * 工具参数还在生成时也按工具名选择，未知工具用扳手兜底，不因缺映射留出空白。
 */
const ICONS = {
  thinking: IThink, plan: ICheck, note: IInfo, compact: ILayers, check: ICheck, retry: IWrench,
  read_file: IDoc, read_document: IDoc, list_files: IFolder,
  write_file: IFileEdit, edit_file: IFileEdit, file_op: IFolder, write_document: IFileEdit,
  run_command: ITerminal, run_python: ICode,
  glob: ISearch, grep: ISearch, web_search: ISearch, research: ISearch,
  web_fetch: IGlobe, http_request: IGlobe, download_file: IDownload,
  calculator: ICalc, current_time: IClock, query_data: ICalc, make_chart: IChart,
  create_artifact: IFile, archive: ILayers, ask_user: IInfo,
  load_tools: IWrench, load_skill: ISpark, remember: IThink,
};

export function TraceIcon({ name = "thinking" }: { name?: string }) {
  const Icon = ICONS[name as keyof typeof ICONS] ?? IWrench;
  return <span className="tr-type-icon" aria-hidden="true"><Icon width={16} height={16} /></span>;
}
