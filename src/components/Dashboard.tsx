import React, { useMemo } from 'react';
import { Order, Product } from '../types';

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
};

export default function Dashboard({ orders, products }: DashboardProps) {
  const stats = useMemo(() => {
    const activeOrders = orders.filter((o) => o.status !== '취소');
    const totalQuantity = activeOrders.reduce((sum, o) => sum + o.quantity, 0);
    const totalRevenue = activeOrders.reduce((sum, o) => sum + o.totalPrice, 0);
    const totalDeposit = activeOrders.reduce((sum, o) => sum + o.depositAmount, 0);
    const outstanding = totalRevenue - totalDeposit;

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

    const recentOrders = [...orders]
      .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
      .slice(0, 5);

    return {
      totalOrders: orders.length,
      activeOrders: activeOrders.length,
      totalQuantity,
      totalRevenue,
      totalDeposit,
      outstanding,
      statusCounts,
      paymentCounts,
      topProducts,
      upcomingPickups,
      recentOrders,
    };
  }, [orders]);

  return (
    <div className='dashboard-shell'>
      <section className='summary dashboard-summary'>
        <div className='summary-card'>
          <span className='summary-label'>전체 주문</span>
          <span className='summary-count'>{stats.totalOrders}</span>
        </div>
        <div className='summary-card'>
          <span className='summary-label'>진행 중 주문</span>
          <span className='summary-count'>{stats.activeOrders}</span>
        </div>
        <div className='summary-card'>
          <span className='summary-label'>총 수량</span>
          <span className='summary-count'>{stats.totalQuantity}</span>
        </div>
        <div className='summary-card revenue'>
          <span className='summary-label'>총 매출</span>
          <span className='summary-count'>{formatCurrency(stats.totalRevenue)}</span>
        </div>
        <div className='summary-card'>
          <span className='summary-label'>총 입금</span>
          <span className='summary-count'>{formatCurrency(stats.totalDeposit)}</span>
        </div>
        <div className={`summary-card outstanding ${stats.outstanding > 0 ? 'alert' : ''}`}>
          <span className='summary-label'>미수금</span>
          <span className='summary-count'>{formatCurrency(stats.outstanding)}</span>
        </div>
      </section>

      <div className='dashboard-grid'>
        <section className='panel'>
          <h2>주문 상태 현황</h2>
          <div className='status-grid'>
            {['접수', '준비중', '완료', '취소'].map((status) => (
              <div key={status} className={`status-box status-${status}`}>
                <span className='status-name'>{status}</span>
                <span className='status-value'>{stats.statusCounts[status] || 0}건</span>
              </div>
            ))}
          </div>
        </section>

        <section className='panel'>
          <h2>입금 상태 현황</h2>
          <div className='status-grid'>
            {['미납', '부분납', '완납'].map((status) => (
              <div key={status} className={`status-box payment-${status}`}>
                <span className='status-name'>{status}</span>
                <span className='status-value'>{stats.paymentCounts[status] || 0}건</span>
              </div>
            ))}
          </div>
        </section>

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
      </div>
    </div>
  );
}
