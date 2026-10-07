import React, { useMemo } from 'react';
import { Order, Product } from '../types';
import PreparationSettings from './PreparationSettings';

function formatCurrency(value: number) {
  return value.toLocaleString('ko-KR') + '원';
}

function formatDate(date: string | undefined) {
  if (!date) return '-';
  const d = new Date(date);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function getPaymentStatus(order: Order): string {
  if (order.status === '취소') return '완납';
  if (order.depositAmount >= order.totalPrice) return '완납';
  if (order.depositAmount <= 0) return '미납';
  return '부분납';
}

type DashboardProps = {
  orders: Order[];
  products: Product[];
  preparationDays: number;
  canEditPreparation: boolean;
  onSavePreparationDays: (days: number) => void;
  onNavigate: (page: 'orders') => void;
  onStatusFilter?: (status: string) => void;
};

export default function Dashboard({ orders, products, preparationDays, canEditPreparation, onSavePreparationDays, onNavigate, onStatusFilter }: DashboardProps) {
  function handleStatusClick(status: string) {
    onStatusFilter?.(status);
    onNavigate('orders');
  }
  const stats = useMemo(() => {
    const activeOrders = orders.filter((o) => o.status !== '취소' && o.status !== '환불완료');
    const totalQuantity = activeOrders.reduce((sum, o) => sum + o.quantity, 0);
    const totalRevenue = activeOrders.reduce((sum, o) => sum + o.totalPrice, 0);
    const totalDeposit = activeOrders.reduce((sum, o) => sum + o.depositAmount, 0);
    const outstanding = activeOrders
      .filter((o) => o.status !== '환불완료')
      .reduce((sum, o) => sum + (o.totalPrice - o.depositAmount), 0);

    const statusCounts: Record<string, number> = {
      접수: 0,
      준비중: 0,
      완료: 0,
      취소: 0,
    };
    orders.forEach((o) => {
      statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
    });

    const paymentCounts: Record<string, number> = { 미납: 0, 부분납: 0, 완납: 0 };
    activeOrders.forEach((o) => {
      paymentCounts[getPaymentStatus(o)]++;
    });

    const productMap = new Map<string, { name: string; quantity: number; revenue: number }>();
    activeOrders.forEach((o) => {
      const key = o.cabbageType || '미지정';
      const current = productMap.get(key) || { name: key, quantity: 0, revenue: 0 };
      current.quantity += o.quantity;
      current.revenue += o.totalPrice;
      productMap.set(key, current);
    });
    const topProducts = Array.from(productMap.values())
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 5);

    const upcomingPickups = activeOrders
      .filter((o) => o.pickupDate && new Date(o.pickupDate) >= new Date(new Date().toDateString()))
      .sort((a, b) => +new Date(a.pickupDate) - +new Date(b.pickupDate))
      .slice(0, 5);

    // 준비일/수령일이 7일 이내로 다가온 주문을 미리 알림으로 표시
    const todayStart = new Date(new Date().toDateString());
    const inDays = (dateStr?: string) => {
      if (!dateStr) return null;
      return Math.round((+new Date(dateStr) - +todayStart) / 86400000);
    };
    const dueAlerts = activeOrders
      .map((o) => {
        const prep = inDays(o.preparationDate);
        const pickup = inDays(o.pickupDate);
        const candidates = [
          prep !== null && prep >= 0 && prep <= 7 ? { kind: '준비' as const, days: prep, date: o.preparationDate } : null,
          pickup !== null && pickup >= 0 && pickup <= 7 ? { kind: '수령' as const, days: pickup, date: o.pickupDate } : null,
        ].filter(Boolean) as { kind: '준비' | '수령'; days: number; date?: string }[];
        if (candidates.length === 0) return null;
        const soonest = candidates.sort((a, b) => a.days - b.days)[0];
        return { order: o, ...soonest };
      })
      .filter(Boolean)
      .sort((a, b) => (a!.days - b!.days) || (+new Date(a!.order.pickupDate) - +new Date(b!.order.pickupDate))) as {
      order: Order;
      kind: '준비' | '수령';
      days: number;
      date?: string;
    }[];

    const recentOrders = [...orders]
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, 5);

    return {
      totalOrders: activeOrders.length,
      activeOrders: activeOrders.length,
      totalQuantity,
      totalRevenue,
      totalDeposit,
      outstanding,
      statusCounts,
      paymentCounts,
      topProducts,
      upcomingPickups,
      dueAlerts,
      recentOrders,
    };
  }, [orders]);

  return (
    <div className='dashboard-shell'>
      <section className='summary dashboard-summary'>
        <button className='summary-card' onClick={() => onNavigate('orders')} title='주문관리로 이동'>
          <span className='summary-label'>전체 주문</span>
          <span className='summary-count'>{stats.totalOrders}</span>
        </button>
        <button className='summary-card' onClick={() => onNavigate('orders')} title='주문관리로 이동'>
          <span className='summary-label'>진행 중 주문</span>
          <span className='summary-count'>{stats.activeOrders}</span>
        </button>
        <button className='summary-card' onClick={() => onNavigate('orders')} title='주문관리로 이동'>
          <span className='summary-label'>총 수량</span>
          <span className='summary-count'>{stats.totalQuantity}</span>
        </button>
        <button
          className={`summary-card outstanding ${stats.outstanding > 0 ? 'alert' : ''}`}
          onClick={() => onNavigate('orders')}
          title='입금금액 확인 - 주문관리로 이동'
        >
          <span className='summary-label'>{stats.outstanding > 0 ? '입금금액' : '입금완료'}</span>
          <span className='summary-count'>
            {stats.outstanding > 0 ? formatCurrency(stats.outstanding) : '입금완료'}
          </span>
        </button>
      </section>

      <div className='dashboard-grid'>
        <section className='panel'>
          <h2>주문 상태 현황</h2>
          <div className='status-grid'>
            {(canEditPreparation ? ['접수', '준비중', '완료', '취소', '환불완료'] : ['접수', '준비중', '완료']).map((status) => (
              <button
                key={status}
                type='button'
                className={`status-box status-${status} status-box-btn`}
                onClick={() => handleStatusClick(status)}
                title={`주문관리에서 '${status}' 주문 보기`}
              >
                <span className='status-name'>{status}</span>
                <span className='status-value'>{stats.statusCounts[status] || 0}건</span>
              </button>
            ))}
          </div>
        </section>

        {canEditPreparation && (
        <section className='panel'>
          <h2>입금 상태 현황</h2>
          <div className='status-grid'>
            {['미납', '부분납', '완납'].map((status) => (
              <button
                key={status}
                type='button'
                className={`status-box payment-${status} status-box-btn`}
                onClick={() => handleStatusClick(status)}
                title={`주문관리에서 '${status}' 주문 보기`}
              >
                <span className='status-name'>{status}</span>
                <span className='status-value'>{stats.paymentCounts[status] || 0}건</span>
              </button>
            ))}
          </div>
        </section>
        )}

        <section className='panel'>
          <h2>인기 품목 TOP 5</h2>
          {stats.topProducts.length === 0 ? (
            <div className='empty'>주문 데이터가 없습니다.</div>
          ) : (
            <ul className='rank-list'>
              {stats.topProducts.map((p, idx) => (
                <li key={p.name} className='rank-item'>
                  <span className='rank-number'>{idx + 1}</span>
                  <span className='rank-name'>{p.name}</span>
                  <span className='rank-value'>{p.quantity}개 / {formatCurrency(p.revenue)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {canEditPreparation && (
        <section className='panel'>
          <h2>다가오는 수령/배송</h2>
          {stats.upcomingPickups.length === 0 ? (
            <div className='empty'>예정된 수령/배송이 없습니다.</div>
          ) : (
            <ul className='simple-list'>
              {stats.upcomingPickups.map((o) => (
                <li key={o.id}>
                  <div className='list-dates'>
                    <span className='tag highlight'>수령 {formatDate(o.pickupDate)}</span>
                    <span className='tag'>접수 {formatDate(o.createdAt)}</span>
                    {o.preparationDate && <span className='tag'>준비 {formatDate(o.preparationDate)}</span>}
                  </div>
                  <div className='list-content'>
                    {o.name} · {o.cabbageType} {o.quantity}{o.unit}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        )}

        {canEditPreparation && (
          <PreparationSettings days={preparationDays} onSave={onSavePreparationDays} />
        )}

        {canEditPreparation && (
        <section className='panel dashboard-wide'>
          <h2>🔔 준비/수령 미리 알림 (7일 이내)</h2>
          {stats.dueAlerts.length === 0 ? (
            <div className='empty'>7일 이내 준비 또는 수령 예정 주문이 없습니다.</div>
          ) : (
            <ul className='simple-list'>
              {stats.dueAlerts.map((a) => (
                <li key={`${a.order.id}-${a.kind}`} onClick={() => onNavigate('orders')} style={{ cursor: 'pointer' }}>
                  <div className='list-dates'>
                    <span
                      className={`tag ${a.days <= 1 ? 'highlight' : ''}`}
                      style={a.days <= 1 ? { background: '#fef2f2', color: '#dc2626' } : undefined}
                    >
                      {a.kind}{' '}
                      {a.days === 0 ? '오늘' : a.days === 1 ? '내일' : `D-${a.days}`}
                    </span>
                    <span className='tag'>{a.kind}일 {a.date ? formatDate(a.date) : '-'}</span>
                    <span className={`tag status-${a.order.status}`}>{a.order.status}</span>
                  </div>
                  <div className='list-content'>
                    {a.order.name} · {a.order.cabbageType} {a.order.quantity}{a.order.unit}
                    {a.kind === '준비' && a.order.pickupDate ? ` · 수령 ${formatDate(a.order.pickupDate)}` : ''}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        )}

        {canEditPreparation && (
        <section className='panel dashboard-wide'>
          <h2>최근 접수 주문</h2>
          {stats.recentOrders.length === 0 ? (
            <div className='empty'>최근 주문이 없습니다.</div>
          ) : (
            <ul className='simple-list'>
              {stats.recentOrders.map((o) => (
                <li key={o.id}>
                  <div className='list-dates'>
                    <span className='tag'>접수 {formatDate(o.createdAt)}</span>
                    {o.preparationDate && <span className='tag'>준비 {formatDate(o.preparationDate)}</span>}
                    {o.pickupDate && <span className='tag'>수령 {formatDate(o.pickupDate)}</span>}
                    <span className={`tag status-${o.status}`}>{o.status}</span>
                  </div>
                  <div className='list-content'>
                    {o.name} · {o.cabbageType} {o.quantity}{o.unit} · {formatCurrency(o.totalPrice)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        )}
      </div>
    </div>
  );
}
