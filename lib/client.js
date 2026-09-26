/**
 * dsh-chatjimmy — browser half.
 *
 * One surface: the ChatJimmy card on the Plugins page, keyed on the
 * `chatjimmy` settings namespace the host half declares as its row id. Every
 * field of the row that the host marks `volatile()` is editable here, and the
 * adapter resolves the row per read, so a save lands on the next request
 * without remounting the provider route.
 *
 * The form stages edits locally and writes them in one `scope.mutate` call:
 * a half-typed base URL must not reach the settings document field by field.
 * Chrome is a stylesheet, not inline style objects — the module system claims
 * every `<style>` tag a factory appends while it materializes and removes it
 * when the package unloads. Classes are `cj-`-prefixed because that sheet
 * lands in the page's own document.
 *
 * This file is plain JavaScript on purpose. The client module system serves a
 * package's `exports["./client"]` artifact as a lazy-CJS factory registered on
 * `window.__ModuleLoader__`, and that is the whole format — an out-of-tree
 * plugin can author it directly instead of reproducing the repository's tsdown
 * client preset. `react` is provided by the module system; nothing else is
 * required here.
 */

window.__ModuleLoader__.load({
  id: 'dsh-chatjimmy',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Settings namespace shared with the host half; also this card's slot key. */
    const NAMESPACE = 'chatjimmy'

    /** Locale namespace for this plugin's copy. */
    const LOCALE_NS = 'chatjimmy'

    /**
     * Every editable row field, in display order. `integer` fields are sent as
     * numbers and must be positive integers; the host schema bounds each one,
     * and the card refuses what it can see before the write.
     */
    const FIELDS = [
      { key: 'baseUrl', kind: 'text', label: 'labelBaseUrl', hint: 'hintBaseUrl' },
      { key: 'model', kind: 'text', label: 'labelModel', hint: 'hintModel' },
      { key: 'topK', kind: 'integer', label: 'labelTopK', hint: 'hintTopK' },
      { key: 'contextWindow', kind: 'integer', label: 'labelContextWindow', hint: 'hintContextWindow' },
      { key: 'streamIdleTimeoutMs', kind: 'integer', label: 'labelStreamIdleTimeoutMs', hint: 'hintStreamIdleTimeoutMs' },
    ]

    /** Every class is `cj-`-prefixed: the sheet lands in the page's own document. */
    const CSS = [
      '.cj-page{display:flex;flex-direction:column;gap:12px}',
      '.cj-field{display:flex;flex-direction:column;gap:4px}',
      '.cj-label{font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.cj-hint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.cj-input{font:inherit;font-size:13px;line-height:1.5;padding:5px 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;width:100%;box-sizing:border-box}',
      '.cj-input:disabled{cursor:default;opacity:.5}',
      '.cj-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.cj-button{appearance:none;font:inherit;font-size:13px;line-height:1.5;padding:5px 14px;cursor:pointer;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-4);border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.cj-button:disabled{cursor:default;opacity:.5}',
      '.cj-button-quiet{padding:3px 10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.cj-status{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.cj-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
    ].join('')

    // Appended while the factory materializes: the module system claims the tag
    // for this package and disposes it on unload. Guarded because the node unit
    // tests evaluate this file without a DOM.
    if (typeof document !== 'undefined') {
      const style = document.createElement('style')
      style.textContent = CSS
      document.head.append(style)
    }

    /** Plugin version, shown in the card footer. Kept in lockstep with package.json. */
    const VERSION = '0.6.3'

    const en = {
      title: 'ChatJimmy',
      summary: 'ChatJimmy text provider — model {model} at {baseUrl}.',
      summaryEmpty: 'ChatJimmy text provider (not configured yet).',
      description: 'ChatJimmy text provider — {model}',
      labelBaseUrl: 'Base URL',
      labelModel: 'Model',
      labelTopK: 'topK',
      labelContextWindow: 'Context window (tokens)',
      labelStreamIdleTimeoutMs: 'Stream idle timeout (ms)',
      hintBaseUrl: 'Deployment origin, no trailing slash needed.',
      hintModel: 'Model id sent as chatOptions.selectedModel.',
      hintTopK: 'Sampling breadth forwarded to the service. The site itself sends 8.',
      hintContextWindow: 'Prompt + completion tokens; the service enforces 6144.',
      hintStreamIdleTimeoutMs: 'A stream silent for this long ends with the TIMEOUT failure.',
      overridden: 'overridden',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The next request uses these values.',
      reset: 'Reset to defaults',
      persists: 'Stored in your profile; the adapter reads the row on every request.',
      readOnly: 'Read-only: this deployment does not persist settings.',
      baseUrlInvalid: 'Base URL must be an absolute http(s) URL.',
      modelInvalid: 'Model must be a non-empty id.',
      numberInvalid: 'Must be a positive whole number.',
      rejected: 'The Host refused the write; the previous values are still in effect.',
      failed: 'Could not save: {message}',
      version: 'v{version}',
    }

    const zh = {
      title: 'ChatJimmy',
      summary: 'ChatJimmy 文本提供方 — 模型 {model}，地址 {baseUrl}。',
      summaryEmpty: 'ChatJimmy 文本提供方（尚未配置）。',
      description: 'ChatJimmy 文本提供方 — {model}',
      labelBaseUrl: '基础地址',
      labelModel: '模型',
      labelTopK: 'topK',
      labelContextWindow: '上下文窗口（token）',
      labelStreamIdleTimeoutMs: '流空闲超时（毫秒）',
      hintBaseUrl: '部署地址，结尾的斜杠可省略。',
      hintModel: '作为 chatOptions.selectedModel 发送的模型 id。',
      hintTopK: '转发给服务的采样广度。站点自身发送 8。',
      hintContextWindow: '提示词与回复合计的 token 数；服务上限为 6144。',
      hintStreamIdleTimeoutMs: '流在该时长内无输出即以 TIMEOUT 结束。',
      overridden: '已覆盖',
      save: '保存',
      saving: '保存中…',
      saved: '已保存。下一个请求将使用这些值。',
      reset: '恢复默认',
      persists: '保存在你的配置中；适配器每次请求都会读取该行。',
      readOnly: '只读：此部署不持久化设置。',
      baseUrlInvalid: '基础地址必须是绝对的 http(s) URL。',
      modelInvalid: '模型必须是非空 id。',
      numberInvalid: '必须是正整数。',
      rejected: 'Host 拒绝了写入；原先的值仍然有效。',
      failed: '保存失败：{message}',
      version: 'v{version}',
    }

    /**
     * Bind one settings scope to a React subscription.
     * @param scope - the scope bound to the chatjimmy settings namespace.
     * @returns a hook reading that scope's current snapshot.
     */
    function useScope(scope) {
      const subscribe = (listener) => scope.subscribe(listener)
      const getSnapshot = () => scope.getSnapshot()
      return () => React.useSyncExternalStore(subscribe, getSnapshot)
    }

    /**
     * Read a snapshot's resolved row. A namespace this deployment does not
     * serve reports no row, which the card renders as nothing at all.
     * @param snapshot - the settings scope snapshot.
     * @returns the resolved row, or `undefined` when unreadable.
     */
    function rowOf(snapshot) {
      if (snapshot.status !== 'ready') return undefined
      return snapshot.value !== null && typeof snapshot.value === 'object' ? snapshot.value : {}
    }

    /** One editable field: label, hint, input, and the override marker. */
    function Field(props) {
      const { t, field, value, overridden, disabled, onChange } = props
      return React.createElement(
        'div',
        { className: 'cj-field' },
        React.createElement(
          'div',
          { className: 'cj-row' },
          React.createElement('span', { className: 'cj-label' }, t(field.label)),
          overridden === true
            ? React.createElement('span', { className: 'cj-hint' }, `(${t('overridden')})`)
            : null,
        ),
        React.createElement('input', {
          className: 'cj-input',
          type: field.kind === 'integer' ? 'number' : 'text',
          value: value,
          disabled,
          'aria-label': t(field.label),
          onChange: (event) => { onChange(field.key, event.target.value) },
        }),
        React.createElement('span', { className: 'cj-hint' }, t(field.hint)),
      )
    }

    /**
     * Build the card component over one bound settings scope.
     * @param scope - the scope bound to the chatjimmy settings namespace.
     * @param t - translate function bound to this plugin's locale namespace.
     * @returns the component the slot renders.
     */
    function createCard(scope, t) {
      const useChatJimmy = useScope(scope)

      return function ChatJimmyCard(props) {
        const snapshot = useChatJimmy()
        const [draft, setDraft] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [status, setStatus] = React.useState(null)

        const row = rowOf(snapshot)
        // A namespace this deployment does not serve renders no trace of itself.
        if (row === undefined) return null

        if (props != null && props.view === 'summary') {
          return row.model === undefined
            ? t('summaryEmpty')
            : t('summary', { model: String(row.model), baseUrl: String(row.baseUrl) })
        }

        const disabled = !snapshot.writable
        const shown = draft ?? row
        const user = snapshot.user !== null && typeof snapshot.user === 'object' ? snapshot.user : {}

        /**
         * Validate and collect the staged edits.
         * @returns an error key, or the ordered path operations to write.
         */
        const collect = () => {
          const ops = []
          for (const field of FIELDS) {
            const value = shown[field.key]
            const original = row[field.key]
            if (String(value) === String(original)) continue
            if (field.kind === 'integer') {
              const parsed = Number(value)
              if (!Number.isInteger(parsed) || parsed <= 0) return { error: 'numberInvalid' }
              ops.push({ op: 'set', path: [field.key], value: parsed })
              continue
            }
            const text = String(value).trim()
            if (field.key === 'model') {
              if (text === '') return { error: 'modelInvalid' }
              ops.push({ op: 'set', path: [field.key], value: text })
              continue
            }
            if (text === '' || !/^https?:\/\//u.test(text)) return { error: 'baseUrlInvalid' }
            ops.push({ op: 'set', path: [field.key], value: text })
          }
          return { ops }
        }

        const save = () => {
          setError(null)
          const result = collect()
          if (result.error !== undefined) {
            setError(t(result.error))
            return
          }
          if (result.ops.length === 0) {
            // Nothing moved: an edit that landed back on the stored value is
            // not a change, and the row already holds it.
            setStatus(null)
            return
          }
          setStatus(t('saving'))
          Promise.resolve(scope.mutate(result.ops))
            .then((accepted) => {
              if (accepted === false) {
                setError(t('rejected'))
                setStatus(null)
                return
              }
              setDraft(null)
              setStatus(t('saved'))
            })
            .catch((cause) => {
              setStatus(null)
              setError(t('failed', { message: cause instanceof Error ? cause.message : String(cause) }))
            })
        }

        const reset = () => {
          setDraft(null)
          setStatus(null)
          const ops = Object.keys(user)
            .filter((key) => FIELDS.some((field) => field.key === key))
            .map((key) => ({ op: 'unset', path: [key] }))
          if (ops.length === 0) return
          Promise.resolve(scope.mutate(ops)).catch((cause) => {
            setError(t('failed', { message: cause instanceof Error ? cause.message : String(cause) }))
          })
        }

        const overridden = Object.keys(user).some((key) => FIELDS.some((field) => field.key === key))

        return React.createElement(
          'div',
          { className: 'cj-page' },
          ...FIELDS.map((field) => React.createElement(Field, {
            key: field.key,
            t,
            field,
            value: String(shown[field.key] ?? ''),
            overridden: Object.hasOwn(user, field.key),
            disabled,
            onChange: (key, value) => {
              setStatus(null)
              setDraft({ ...shown, [key]: value })
            },
          })),
          React.createElement(
            'div',
            { className: 'cj-row' },
            React.createElement(
              'button',
              { type: 'button', className: 'cj-button', disabled, onClick: save },
              t('save'),
            ),
            overridden
              ? React.createElement(
                'button',
                { type: 'button', className: 'cj-button cj-button-quiet', disabled, onClick: reset },
                t('reset'),
              )
              : null,
          ),
          React.createElement(
            'div',
            { className: 'cj-status' },
            status ?? (snapshot.writable ? t('persists') : t('readOnly')),
            ' ',
            t('version', { version: VERSION }),
          ),
          error === null ? null : React.createElement('div', { className: 'cj-error' }, error),
        )
      }
    }

    /**
     * Mount the browser surface: the ChatJimmy card on the Plugins page.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, { en, zh }),
        'dsh-chatjimmy: locale dictionary',
      )

      const scope = ctx.configForms.get(NAMESPACE)
      const Card = createCard(scope, t)

      // The owner declares its own slot; injecting waits for it to exist, so
      // this registration does not depend on plugin load order. The card takes
      // no injected props — it closes over its own bound scope — so the entry
      // declares the documented `locale` namespace and no `inject`.
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-chatjimmy#chatjimmy',
        locale: LOCALE_NS,
      }, Card))
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms', 'locale']
    return module.exports
  },
})
