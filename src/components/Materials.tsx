import React, { useEffect, useMemo, useState } from 'react';
import { Material, Order } from '../types';
import { load, save } from '../lib/storage';
import { compressImage, saveSafely } from '../lib/images';
import { deleteMaterialApi, fetchReceipt, syncAppData, uploadReceipt } from '../lib/api';

const MATERIALS_KEY = 'jc-materials';

const emptyMaterial = {
  date: new Date().toISOString().slice(0, 10),
  name: '',
  category: '자재',
  quantity: 1,
  unit: '개',
  unitPrice: 0,
  vendor: '',
  memo: '',
};

function formatCurrency(value: number) {
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

function loadMaterials(): Material[] {
  return load<Material[]>(MATERIALS_KEY, []);
}

function saveMaterials(materials: Material[]) {
  save(MATERIALS_KEY, materials);
}

export function Materials({ orders }: { orders: Order[] }) {
  const [materials, setMaterials] = useState<Material[]>(loadMaterials);
  const [tab, setTab] = useState<'list' | 'pnl'>('list');
  const [form, setForm] = useState({ ...emptyMaterial });
  const [receipt, setReceipt] = useState<string>('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [viewReceipt, setViewReceipt] = useState<string | null>(null);
  const [filterMonth, setFilterMonth] = useState('');
  const [saving, setSaving] = useState(false);
  // 영수증 사진은 서버에 저장(receipts 테이블), 자재에는 참조 ID만 보관
  const [receiptId, setReceiptId] = useState<string | null>(null);

  // 다른 기기에서 자재 데이터가 바뀌면 목록 갱신
  useEffect(() => {
    const reload = (e?: Event) => {
      // 이벤트에 서버 값 payload가 있으면 그대로 반영 (localStorage 용량 초과 시에도 최신 유지)
      const detail = (e as CustomEvent).detail;
      if (Array.isArray(detail)) {
        setMaterials(detail as Material[]);
        return;
      }
      setMaterials(loadMaterials());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === MATERIALS_KEY) reload();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('jc-materials-updated', reload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('jc-materials-updated', reload);
    };
  }, []);

  function persist(next: Material[]): boolean {
    // 화면 상태를 먼저 반영한다. localStorage 용량 초과로 저장에 실패해도
    // 서버 DB에 저장되므로 목록이 사라지지 않는다.
    const ok = saveSafely((v) => saveMaterials(v as Material[]), next);
    setMaterials(next);
    // 로컬 저장 여부와 관계없이 서버 DB에 즉시 저장 (실시간)
    void syncAppData('materials', next).catch(() => {});
    return ok;
  }

  async function handleReceiptFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const compressed = await compressImage(file);
    // 영수증은 즉시 서버에 저장하고 자재 항목에는 ID만 연결한다
    const id = editingId || crypto.randomUUID();
    setReceiptId(id);
    setReceipt(compressed);
    e.target.value = '';
    try {
      await uploadReceipt(id, compressed);
    } catch (err: any) {
      alert(err.message || '영수증 저장에 실패했습니다.');
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      alert('자재명을 입력해주세요.');
      return;
    }
    const quantity = Math.max(1, Number(form.quantity) || 1);
    // 음수 단가 허용 (할인/환불 등 차감 항목 입력 가능)
    const unitPrice = Number(form.unitPrice) || 0;
    const totalPrice = quantity * unitPrice;
    setSaving(true);
    try {
      let next: Material[];
      // 사진은 receipts 테이블(서버)에 저장되고 자재에는 receiptId만 남는다.
      // 구버전 인라인 receipt 필드는 더 이상 저장하지 않는다.
      if (editingId) {
        next = materials.map((m) =>
          m.id === editingId
            ? {
                ...m,
                ...form,
                name: form.name.trim(),
                quantity,
                unitPrice,
                totalPrice,
                ...(receipt && receiptId ? { receiptId } : {}),
                receipt: undefined,
              }
            : m
        );
      } else {
        next = [
          {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            ...form,
            name: form.name.trim(),
            quantity,
            unitPrice,
            totalPrice,
            ...(receipt && receiptId ? { receiptId } : {}),
            receipt: undefined,
          },
          ...materials,
        ];
      }
      if (!persist(next)) {
        alert('기기 저장 공간이 부족합니다. 내역은 서버에 저장되었으니 다른 기기에서 확인해주세요.');
        return;
      }
      setForm({ ...emptyMaterial });
      setReceipt('');
      setReceiptId(null);
      setEditingId(null);
    } finally {
      setSaving(false);
    }
  }

  function startEdit(m: Material) {
    setForm({
      date: m.date,
      name: m.name,
      category: m.category || '자재',
      quantity: m.quantity,
      unit: m.unit,
      unitPrice: m.unitPrice,
      vendor: m.vendor || '',
      memo: m.memo || '',
    });
    setEditingId(m.id);
    setReceiptId(m.receiptId || m.id);
    // 영수증 미리보기: 서버에서 조회 (구버전 인라인 receipt는 그대로 사용)
    if (m.receipt) {
      setReceipt(m.receipt);
    } else if (m.receiptId) {
      setReceipt('');
      void fetchReceipt(m.receiptId).then((data) => {
        if (data) setReceipt(data);
      });
    } else {
      setReceipt('');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function removeMaterial(id: string) {
    if (!confirm('이 자재 내역을 삭제하시겠습니까?')) return;
    persist(materials.filter((m) => m.id !== id));
    // 서버 DB에서도 실제로 삭제 (삭제 기록이 남아 오래된 기기가 되살리지 못함)
    void deleteMaterialApi(id).catch(() => {});
  }

  const months = useMemo(() => {
    const set = new Set<string>();
    materials.forEach((m) => m.date && set.add(m.date.slice(0, 7)));
    orders.forEach((o) => o.createdAt && set.add(o.createdAt.slice(0, 7)));
    return Array.from(set).sort().reverse();
  }, [materials, orders]);

  const pnl = useMemo(() => {
    const inMonth = (ym: string) => !filterMonth || ym === filterMonth;
    // 판매매출: 취소 주문 제외, 주문 접수일 기준
    const salesOrders = orders.filter((o) => o.status !== '취소' && inMonth(o.createdAt?.slice(0, 7) || ''));
    const sales = salesOrders.reduce((sum, o) => sum + (Number(o.totalPrice) || 0), 0);
    const received = salesOrders.reduce((sum, o) => sum + (Number(o.depositAmount) || 0), 0);
    const soldQuantity = salesOrders.reduce((sum, o) => sum + (Number(o.quantity) || 0), 0);
    const periodMaterials = materials.filter((m) => inMonth(m.date?.slice(0, 7) || ''));
    const materialCost = periodMaterials
      .filter((m) => (m.category || '자재') === '자재')
      .reduce((sum, m) => sum + (Number(m.totalPrice) || 0), 0);
    const otherCost = periodMaterials
      .filter((m) => (m.category || '자재') !== '자재')
      .reduce((sum, m) => sum + (Number(m.totalPrice) || 0), 0);
    const totalCost = materialCost + otherCost;
    const profit = sales - totalCost;
    const unitCost = soldQuantity > 0 ? totalCost / soldQuantity : 0;
    const costRate = sales > 0 ? (totalCost / sales) * 100 : 0;
    return { sales, received, soldQuantity, materialCost, otherCost, totalCost, profit, unitCost, costRate };
  }, [orders, materials, filterMonth]);

  const filteredList = useMemo(() => {
    if (!filterMonth) return materials;
    return materials.filter((m) => (m.date || '').slice(0, 7) === filterMonth);
  }, [materials, filterMonth]);

  const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', padding: '0.55rem 0', borderBottom: '1px solid #e5e7eb' };
  const labelStyle: React.CSSProperties = { color: '#6b7280', fontSize: '0.92rem' };
  const valueStyle: React.CSSProperties = { fontWeight: 600 };

  return (
    <section>
      <div className='toolbar' style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        <button className={`btn ${tab === 'list' ? 'btn-primary' : ''}`} onClick={() => setTab('list')}>
          📦 자재구입 목록
        </button>
        <button className={`btn ${tab === 'pnl' ? 'btn-primary' : ''}`} onClick={() => setTab('pnl')}>
          💹 손익·원가 계산
        </button>
        <select
          className='input'
          style={{ width: 'auto' }}
          value={filterMonth}
          onChange={(e) => setFilterMonth(e.target.value)}
          title='기간 선택'
        >
          <option value=''>전체 기간</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      {tab === 'list' && (
        <>
          <section className='panel form-panel'>
            <h3>{editingId ? '자재 구입 내역 수정' : '자재 구입 등록'}</h3>
            <form onSubmit={handleSubmit}>
              <div className='form-grid'>
                <label>
                  <span>구입일</span>
                  <input
                    className='input'
                    type='date'
                    value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                  />
                </label>
                <label>
                  <span>분류</span>
                  <input
                    className='input'
                    type='text'
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    placeholder='예: 자재, 기타비용, 운송비, 인건비'
                  />
                </label>
                <label>
                  <span>자재명 *</span>
                  <input
                    className='input'
                    type='text'
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder='예: 배추, 고춧가루, 박스'
                    required
                  />
                </label>
                <label>
                  <span>수량</span>
                  <input
                    className='input'
                    type='number'
                    min='1'
                    value={form.quantity}
                    onChange={(e) => setForm({ ...form, quantity: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>단위</span>
                  <input
                    className='input'
                    type='text'
                    value={form.unit}
                    onChange={(e) => setForm({ ...form, unit: e.target.value })}
                  />
                </label>
                <label>
                  <span>단가</span>
                  <input
                    className='input'
                    type='number'
                    value={form.unitPrice}
                    onChange={(e) => setForm({ ...form, unitPrice: Number(e.target.value) })}
                  />
                </label>
                <label>
                  <span>총액 (자동)</span>
                  <input
                    className='input'
                    type='text'
                    readOnly
                    value={formatCurrency((Number(form.quantity) || 0) * (Number(form.unitPrice) || 0))}
                  />
                </label>
                <label>
                  <span>구입처</span>
                  <input
                    className='input'
                    type='text'
                    value={form.vendor}
                    onChange={(e) => setForm({ ...form, vendor: e.target.value })}
                    placeholder='예: 농협, 시장 상호'
                  />
                </label>
                <label className='full'>
                  <span>메모</span>
                  <input
                    className='input'
                    type='text'
                    value={form.memo}
                    onChange={(e) => setForm({ ...form, memo: e.target.value })}
                  />
                </label>
                <label className='full'>
                  <span>영수증 첨부 (사진 촬영/선택 가능)</span>
                  <input className='input' type='file' accept='image/*' capture='environment' onChange={handleReceiptFile} />
                  {receipt && (
                    <div style={{ marginTop: '0.5rem' }}>
                      <img
                        src={receipt}
                        alt='영수증 미리보기'
                        style={{ maxWidth: '180px', borderRadius: '8px', cursor: 'pointer' }}
                        onClick={() => setViewReceipt(receipt)}
                      />
                    </div>
                  )}
                </label>
              </div>
              <div className='form-actions'>
                <button
                  type='button'
                  className='btn'
                  onClick={() => {
                    setForm({ ...emptyMaterial });
                    setReceipt('');
                    setReceiptId(null);
                    setEditingId(null);
                  }}
                >
                  초기화
                </button>
                <button type='submit' className='btn btn-primary' disabled={saving}>
                  {saving ? '저장 중...' : editingId ? '수정 저장' : '자재 등록'}
                </button>
              </div>
            </form>
          </section>

          <section className='panel' style={{ marginTop: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
              <h3>자재 구입 목록 ({filteredList.length}건)</h3>
              <span style={labelStyle}>
                합계 <strong style={{ color: '#111827' }}>{formatCurrency(filteredList.reduce((s, m) => s + (Number(m.totalPrice) || 0), 0))}</strong>
              </span>
            </div>
            {filteredList.length === 0 ? (
              <p className='empty'>등록된 자재 내역이 없습니다.</p>
            ) : (
              filteredList.map((m) => (
                <div key={m.id} style={row}>
                  <div>
                    <strong>{m.name}</strong>{' '}
                    <span style={{ ...labelStyle, fontSize: '0.8rem', background: '#f3f4f6', padding: '0.1rem 0.4rem', borderRadius: '6px' }}>
                      {m.category || '자재'}
                    </span>
                    <div style={labelStyle}>
                      {m.date} · {m.quantity}
                      {m.unit} × {formatCurrency(m.unitPrice)}
                      {m.vendor ? ` · ${m.vendor}` : ''}
                      {m.memo ? ` · ${m.memo}` : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span style={valueStyle}>{formatCurrency(m.totalPrice)}</span>
                    {(m.receipt || m.receiptId) && (
                      <button
                        className='btn'
                        onClick={() => {
                          // 구버전 인라인 사진이 있으면 바로 표시, 없으면 서버에서 조회
                          if (m.receipt) {
                            setViewReceipt(m.receipt);
                            return;
                          }
                          void fetchReceipt(m.receiptId || m.id).then((data) => {
                            if (data) setViewReceipt(data);
                            else alert('영수증 사진을 찾을 수 없습니다.');
                          });
                        }}
                        title='영수증 보기'
                      >
                        🧾
                      </button>
                    )}
                    <button className='btn' onClick={() => startEdit(m)} title='수정'>
                      ✎
                    </button>
                    <button className='btn' onClick={() => removeMaterial(m.id)} title='삭제'>
                      ✕
                    </button>
                  </div>
                </div>
              ))
            )}
          </section>
        </>
      )}

      {tab === 'pnl' && (
        <section className='panel'>
          <h3>💹 손익 계산 {filterMonth ? `(${filterMonth})` : '(전체 기간)'}</h3>
          <div style={row}>
            <span style={labelStyle}>판매 매출 (주문 기준, 취소 제외)</span>
            <span style={valueStyle}>{formatCurrency(pnl.sales)}</span>
          </div>
          <div style={row}>
            <span style={labelStyle}>판매 수량</span>
            <span style={valueStyle}>{pnl.soldQuantity.toLocaleString('ko-KR')}개(박스)</span>
          </div>
          <div style={row}>
            <span style={labelStyle}>받은 입금액</span>
            <span style={valueStyle}>{formatCurrency(pnl.received)}</span>
          </div>
          <div style={row}>
            <span style={labelStyle}>자재비</span>
            <span style={valueStyle}>{formatCurrency(pnl.materialCost)}</span>
          </div>
          <div style={row}>
            <span style={labelStyle}>기타비용</span>
            <span style={valueStyle}>{formatCurrency(pnl.otherCost)}</span>
          </div>
          <div style={row}>
            <span style={labelStyle}>총 원가 (자재비+기타비용)</span>
            <span style={valueStyle}>{formatCurrency(pnl.totalCost)}</span>
          </div>
          <div style={{ ...row, borderBottom: 'none' }}>
            <span style={{ ...labelStyle, fontWeight: 700 }}>순이익 (매출-원가)</span>
            <span style={{ ...valueStyle, fontSize: '1.15rem', color: pnl.profit >= 0 ? '#16a34a' : '#dc2626' }}>
              {formatCurrency(pnl.profit)}
            </span>
          </div>
          <div style={{ marginTop: '1rem', background: '#f9fafb', borderRadius: '10px', padding: '0.75rem 1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0' }}>
              <span style={labelStyle}>개당(박스당) 원가</span>
              <span style={valueStyle}>{pnl.soldQuantity > 0 ? formatCurrency(pnl.unitCost) : '-'}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.3rem 0' }}>
              <span style={labelStyle}>매출 대비 원가율</span>
              <span style={valueStyle}>{pnl.sales > 0 ? `${pnl.costRate.toFixed(1)}%` : '-'}</span>
            </div>
          </div>
          <p style={{ ...labelStyle, marginTop: '0.75rem' }}>
            ※ 판매 매출은 주문 관리의 취소되지 않은 주문 합계이며, 자재비·기타비용은 자재구입 목록의 분류별 합계입니다.
          </p>
        </section>
      )}

      {viewReceipt && (
        <div className='modal-overlay' onClick={() => setViewReceipt(null)}>
          <div className='modal panel' style={{ maxWidth: '640px', width: '92vw' }} onClick={(e) => e.stopPropagation()}>
            <div className='modal-header'>
              <h2>영수증</h2>
              <button className='btn icon' onClick={() => setViewReceipt(null)}>
                ✕
              </button>
            </div>
            <img src={viewReceipt} alt='영수증' style={{ maxWidth: '100%', borderRadius: '8px' }} />
          </div>
        </div>
      )}
    </section>
  );
}
