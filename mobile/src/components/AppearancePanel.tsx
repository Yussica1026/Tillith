import type { Appearance } from '../lib/preferences';

export function AppearancePanel({ value, onChange }: { value: Appearance; onChange: (value: Appearance) => void }) {
  return <section className="appearance-panel" aria-label="外观设置">
    <h2>把这里调成喜欢的样子</h2>
    <p className="field-help">外观保存在这台设备，随时可以调整。</p>
    <fieldset className="theme-options"><legend>主题</legend>{([
      ['system', '跟随系统'], ['light', '浅色'], ['dark', '深色'], ['water', '水色'], ['mint', '薄荷'], ['lilac', '丁香'], ['rose', '腮红'],
    ] as const).map(([theme, label]) => <button key={theme} type="button" className={`theme-choice ${value.theme === theme ? 'is-selected' : ''}`} aria-pressed={value.theme === theme} onClick={() => onChange({ ...value, theme })}><i data-swatch={theme} /><span>{label}</span></button>)}</fieldset>
    <label className="dialog-field options-field">正文字号<select aria-label="正文字号" value={value.fontSize} onChange={(event) => onChange({ ...value, fontSize: Number(event.target.value) })}>{[14, 15, 16, 18, 20].map((size) => <option key={size} value={size}>{size} px</option>)}</select></label>
    <label className="dialog-field options-field">消息间距<select aria-label="消息间距" value={value.density} onChange={(event) => onChange({ ...value, density: event.target.value as Appearance['density'] })}><option value="compact">紧凑</option><option value="comfortable">舒适</option><option value="spacious">宽松</option></select></label>
    <label className="dialog-field options-field">代码外观<select aria-label="代码外观" value={value.codeTheme} onChange={(event) => onChange({ ...value, codeTheme: event.target.value as Appearance['codeTheme'] })}><option value="follow">跟随主题</option><option value="light">浅色</option><option value="dark">深色</option><option value="contrast">高对比度</option></select></label>
  </section>;
}
