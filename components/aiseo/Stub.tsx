interface StubProps {
  title: string
  subtitle: string
  willShow: string
  dataSource: string
  layer?: string
}

export default function Stub({
  title,
  subtitle,
  willShow,
  dataSource,
  layer,
}: StubProps) {
  return (
    <div className="ug-page-scroll">
      <div className="wrap">
        <div className="page-header">
          <div>
            <div className="page-title">{title}</div>
            <div className="page-subtitle">{subtitle}</div>
          </div>
          <div className="meta">
            <span className="badge-soon">準備中</span>
          </div>
        </div>
        <div className="stub">
          <div className="stub-title">このページはまだ数字が出ません（データ源 未接続）</div>
          {layer ? (
            <div className="stub-row">
              <span className="stub-k">レイヤ</span>
              <span className="stub-v">{layer}</span>
            </div>
          ) : null}
          <div className="stub-row">
            <span className="stub-k">表示予定</span>
            <span className="stub-v">{willShow}</span>
          </div>
          <div className="stub-row">
            <span className="stub-k">必要なデータ源</span>
            <span className="stub-v">
              {dataSource}
              <span className="pill-off">未接続</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
