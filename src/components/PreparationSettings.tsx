import React, { useEffect, useState } from 'react';

type PreparationSettingsProps = {
  days: number;
  onSave: (days: number) => void;
};

export default function PreparationSettings({ days, onSave }: PreparationSettingsProps) {
  const [draft, setDraft] = useState(String(days));

  useEffect(() => setDraft(String(days)), [days]);

  function save() {
    const next = Math.max(0, Math.min(60, Number(draft) || 0));
    setDraft(String(next));
    onSave(next);
    alert(`준비기간을 ${next}일 전으로 저장했습니다.`);
  }

  return (
    <section className='panel'>
      <h2>준비기간 설정</h2>
      <p className='modal-hint'>
        준비기간을 저장하면 기존 주문의 준비일이 다시 계산됩니다. 새 주문은 오늘부터 설정한 일수 뒤 날짜가 희망일로 자동 입력됩니다.
      </p>
      <label style={{ display: 'block', maxWidth: '320px' }}>
        <span>희망일 기준 준비기간</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.4rem' }}>
          <input
            className='input'
            type='number'
            min='0'
            max='60'
            step='1'
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <strong>일 전</strong>
        </div>
      </label>
      <p className='modal-hint'>예: 4일 전으로 설정하면 수령일이 11월 15일일 때 준비일은 11월 11일입니다.</p>
      <div className='form-actions'>
        <button type='button' className='btn btn-primary' onClick={save}>
          저장
        </button>
      </div>
    </section>
  );
}