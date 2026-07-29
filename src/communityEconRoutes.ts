// 커뮤니티 경제 라우트 — 지갑·소지품·상점·뽑기·선물·도감·일괄 지급.
//
// 게시판 쪽 표와 같은 규칙이다. 항목마다 필요한 권한을 자기 옆에 적어, 빠뜨린 줄이 눈에 띄게 한다.
// 여기서 한 번 더 지키는 것이 하나 더 있다 — **캐릭터를 다루는 라우트는 본문의 charId 를 믿지 않는다.**
// 소유 검사는 econ 의 mutateOwned 안에 갇혀 있고, 이 표는 그 함수만 부른다.
import { ownsOrStaff, fail, from, n, ok, s, type Route } from './communityRouteKit'

const GIFT_ITEMS = 8

export const ECON_ROUTES: Record<string, Route> = {
  // ── 지갑·소지품 ─────────────────────────────────────────────────────────
  '/cmty/econ/view': {
    need: 'member',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      // 남의 지갑을 들여다보는 길을 열지 않는다 — 운영진만 예외다.
      if (!ownsOrStaff(c, d, charId)) return fail('내 캐릭터만 볼 수 있습니다.', 403)
      const view = d.econ.view(charId, c.now)
      if (!view) return fail('캐릭터를 찾을 수 없습니다.', 404)
      return ok({ view, econ: d.community.settings()?.econ ?? null })
    }
  },

  '/cmty/econ/main': {
    need: 'member',
    run(b, c, d) {
      const r = d.chars.setMain(c.account.id, s(b.charId, 64), c.now)
      return from(r, 'char')
    }
  },

  '/cmty/econ/daily': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.daily(c.account.id, s(b.charId, 64), c.now)
      return r.ok ? ok(r.value) : fail(r.error)
    }
  },

  '/cmty/inv/discard': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.discard(c.account.id, s(b.charId, 64), s(b.uid, 64), n(b.qty, 1), c.now)
      return from(r, 'view')
    }
  },

  '/cmty/inv/move': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.moveSlot(c.account.id, s(b.charId, 64), n(b.from, -1), n(b.to, -1), c.now)
      return from(r, 'view')
    }
  },

  '/cmty/inv/mailbox': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.fromMailbox(c.account.id, s(b.charId, 64), s(b.uid, 64), c.now)
      return from(r, 'view')
    }
  },

  '/cmty/inv/use': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.useItem(c.account.id, s(b.charId, 64), s(b.uid, 64), c.now)
      return r.ok ? ok(r.value) : fail(r.error)
    }
  },

  '/cmty/inv/sell': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.sellItem(c.account.id, s(b.charId, 64), s(b.uid, 64), n(b.qty, 1), c.now)
      return r.ok ? ok(r.value) : fail(r.error)
    }
  },

  // ── 도감 ────────────────────────────────────────────────────────────────
  '/cmty/item/list': {
    need: 'member',
    run(_b, c, d) {
      // 감춘 아이템도 운영진에게는 보인다 — 준비 중인 물건을 확인해야 하기 때문이다.
      return ok({ items: d.catalog.items({ includeHidden: c.can('cmty.manageItems') }) })
    }
  },

  '/cmty/item/sources': {
    need: 'member',
    run(b, _c, d) {
      const defId = s(b.defId, 64)
      const item = d.catalog.item(defId)
      if (!item) return fail('아이템을 찾을 수 없습니다.', 404)
      return ok({ item, sources: d.catalog.sourcesOf(defId) })
    }
  },

  // ── 상점 ────────────────────────────────────────────────────────────────
  '/cmty/shop/list': {
    need: 'member',
    run(_b, c, d) {
      const staff = c.can('cmty.manageItems')
      const shops = d.catalog.shops().filter((x) => staff || x.enabled)
      const now = c.now
      const entries = d.catalog
        .entries()
        .filter((e) => shops.some((x) => x.id === e.shopId))
        .filter((e) => staff || (e.enabled && (!e.from || now >= e.from) && (!e.to || now <= e.to)))
      return ok({ shops, entries, items: d.catalog.items({ includeHidden: staff }) })
    }
  },

  '/cmty/shop/buy': {
    need: 'cmty.trade',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.buy(c.account.id, s(b.charId, 64), s(b.entryId, 64), n(b.qty, 1), c.now)
      return r.ok ? ok(r.value) : fail(r.error)
    }
  },

  // ── 뽑기 ────────────────────────────────────────────────────────────────
  '/cmty/gacha/list': {
    need: 'member',
    run(_b, c, d) {
      const staff = c.can('cmty.manageItems')
      return ok({ tables: d.catalog.tables().filter((t) => staff || t.enabled) })
    }
  },

  '/cmty/gacha/odds': {
    need: 'member',
    run(b, c, d) {
      const r = d.econ.odds(s(b.tableId, 64), c.account.id)
      return r.ok ? ok(r.value) : fail(r.error)
    }
  },

  '/cmty/gacha/pull': {
    need: 'cmty.trade',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.gacha(c.account.id, s(b.charId, 64), s(b.tableId, 64), n(b.count, 1), c.now)
      return r.ok ? ok(r.value) : fail(r.error)
    }
  },

  // ── 선물 ────────────────────────────────────────────────────────────────
  '/cmty/gift/offer': {
    need: 'cmty.gift',
    rate: 'econ',
    run(b, c, d) {
      const items = (Array.isArray(b.items) ? b.items : []).slice(0, GIFT_ITEMS).map((raw) => {
        const x = (raw ?? {}) as Record<string, unknown>
        return { uid: s(x.uid, 64), qty: n(x.qty, 1) }
      })
      const r = d.econ.giftOffer(
        c.account.id,
        {
          fromCharId: s(b.fromCharId, 64),
          toCharId: s(b.toCharId, 64),
          g: n(b.g, 0),
          items,
          letter: b.letter,
          image: b.image
        },
        c.now
      )
      if (!r.ok) return fail(r.error)
      d.notify(r.value.toOwnerId, { kind: 'cmty', actor: d.actorOf(c.account), ref: r.value.id, text: `${r.value.fromCharName}이(가) 선물을 보냈습니다.` })
      return ok({ gift: r.value })
    }
  },

  '/cmty/gift/list': {
    need: 'member',
    run(_b, c, d) {
      return ok(d.gifts.listFor(c.account.id))
    }
  },

  '/cmty/gift/get': {
    need: 'member',
    run(b, c, d) {
      const gift = d.gifts.get(s(b.giftId, 64))
      if (!gift) return fail('선물을 찾을 수 없습니다.', 404)
      // 편지는 주고받는 두 사람만 읽는다.
      if (gift.toOwnerId !== c.account.id && gift.fromOwnerId !== c.account.id) return fail('볼 수 없는 선물입니다.', 403)
      return ok({ gift })
    }
  },

  '/cmty/gift/respond': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.giftRespond(c.account.id, s(b.giftId, 64), b.accept === true, c.now)
      if (!r.ok) return fail(r.error)
      d.notify(r.value.fromOwnerId, {
        kind: 'cmty',
        actor: d.actorOf(c.account),
        ref: r.value.id,
        text: b.accept === true ? `${r.value.toCharName}이(가) 선물을 받았습니다.` : `${r.value.toCharName}이(가) 선물을 사양했습니다.`
      })
      return ok({ gift: r.value })
    }
  },

  '/cmty/gift/cancel': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.econ.giftCancel(c.account.id, s(b.giftId, 64), c.now)
      return from(r, 'gift')
    }
  },

  // ── 거래 내역 ───────────────────────────────────────────────────────────
  '/cmty/ledger': {
    need: 'member',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      const all = b.all === true && c.can('cmty.viewLedger')
      if (!all && charId && !ownsOrStaff(c, d, charId)) return fail('내 캐릭터만 볼 수 있습니다.', 403)
      const items = d.ledger.recent({
        // 전체 열람 권한이 없으면 무조건 자기 것으로 좁힌다.
        ...(all ? {} : charId ? { charId } : { ownerId: c.account.id }),
        limit: n(b.limit, 50),
        before: b.before === undefined ? undefined : n(b.before, 0)
      })
      return ok({ items })
    }
  },

  // ── 운영: 정의 ──────────────────────────────────────────────────────────
  '/cmty/admin/item/save': {
    need: 'cmty.manageItems',
    run(b, c, d) {
      const r = d.catalog.saveItem(b.item, c.now)
      if (r.ok) c.audit('item.save', r.value.name, { type: 'item', id: r.value.id, name: r.value.name })
      return from(r, 'item')
    }
  },
  '/cmty/admin/item/remove': {
    need: 'cmty.manageItems',
    run(b, c, d) {
      const r = d.catalog.removeItem(s(b.defId, 64))
      if (r.ok) c.audit('item.remove', r.value.name, { type: 'item', id: r.value.id, name: r.value.name })
      return from(r, 'item')
    }
  },
  '/cmty/admin/shop/save': {
    need: 'cmty.manageItems',
    run(b, c, d) {
      const r = d.catalog.saveShop(b.shop, c.now)
      if (r.ok) c.audit('shop.save', r.value.name, { type: 'shop', id: r.value.id, name: r.value.name })
      return from(r, 'shop')
    }
  },
  '/cmty/admin/shop/remove': {
    need: 'cmty.manageItems',
    run(b, c, d) {
      const r = d.catalog.removeShop(s(b.shopId, 64), c.now)
      if (r.ok) c.audit('shop.remove', r.value.name, { type: 'shop', id: r.value.id, name: r.value.name })
      return from(r, 'shop')
    }
  },
  '/cmty/admin/entry/save': {
    need: 'cmty.manageItems',
    run(b, c, d) {
      const r = d.catalog.saveEntry(b.entry, c.now)
      if (r.ok) {
        const item = d.catalog.item(r.value.defId)
        c.audit('shop.entry', `${item?.name ?? ''} ${r.value.priceG} G`, { type: 'entry', id: r.value.id })
      }
      return from(r, 'entry')
    }
  },
  '/cmty/admin/entry/remove': {
    need: 'cmty.manageItems',
    run(b, c, d) {
      const r = d.catalog.removeEntry(s(b.entryId, 64), c.now)
      if (r.ok) c.audit('shop.entry.remove', '', { type: 'entry', id: r.value.id })
      return from(r, 'entry')
    }
  },
  '/cmty/admin/gacha/save': {
    need: 'cmty.manageItems',
    run(b, c, d) {
      const before = d.catalog.table(s((b.table as Record<string, unknown> | undefined)?.id, 64))
      const r = d.catalog.saveTable(b.table, c.now)
      if (r.ok) {
        // 확률표는 가장 의심받는 항목이라, 바뀐 사실을 지문과 함께 남긴다.
        const changed = before && before.tableHash !== r.value.tableHash
        c.audit('gacha.save', changed ? `확률표 변경 ${before.tableHash} → ${r.value.tableHash}` : r.value.name, {
          type: 'gacha',
          id: r.value.id,
          name: r.value.name
        })
      }
      return from(r, 'table')
    }
  },
  '/cmty/admin/gacha/remove': {
    need: 'cmty.manageItems',
    run(b, c, d) {
      const r = d.catalog.removeTable(s(b.tableId, 64), c.now)
      if (r.ok) c.audit('gacha.remove', r.value.name, { type: 'gacha', id: r.value.id, name: r.value.name })
      return from(r, 'table')
    }
  },

  // ── 운영: 지급·회수 ─────────────────────────────────────────────────────
  '/cmty/admin/econ/give': {
    need: 'cmty.grant',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      const content = {
        g: n(b.g, 0),
        items: (Array.isArray(b.items) ? b.items : []).slice(0, 10).map((raw) => {
          const x = (raw ?? {}) as Record<string, unknown>
          return { defId: s(x.defId, 64), qty: n(x.qty, 1) }
        })
      }
      const memo = s(b.memo, 200)
      const r = d.econ.adminGive({ id: c.account.id, name: c.member?.nick || c.account.username }, charId, content, memo, c.now)
      if (r.ok) c.audit('econ.give', `${content.g} G · ${content.items.length}종 (${memo})`, { type: 'char', id: charId })
      return from(r, 'view')
    }
  },
  '/cmty/admin/econ/take': {
    need: 'cmty.grant',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      const content = {
        g: n(b.g, 0),
        items: (Array.isArray(b.items) ? b.items : []).slice(0, 10).map((raw) => {
          const x = (raw ?? {}) as Record<string, unknown>
          return { defId: s(x.defId, 64), qty: n(x.qty, 1) }
        })
      }
      const memo = s(b.memo, 200)
      const r = d.econ.adminTake({ id: c.account.id, name: c.member?.nick || c.account.username }, charId, content, memo, c.now)
      if (r.ok) c.audit('econ.take', `${content.g} G · ${content.items.length}종 (${memo})`, { type: 'char', id: charId })
      return from(r, 'view')
    }
  },
  '/cmty/admin/econ/cap': {
    need: 'cmty.grant',
    run(b, c, d) {
      const charId = s(b.charId, 64)
      const r = d.econ.setCapBonus(charId, n(b.bonus, 0), c.now)
      if (r.ok) c.audit('econ.cap', `+${n(b.bonus, 0)}칸`, { type: 'char', id: charId })
      return from(r, 'view')
    }
  },

  '/cmty/admin/batch/preview': {
    need: 'cmty.grant',
    run(b, c, d) {
      const r = d.econ.batchPreview(b.spec, c.now)
      return from(r, 'preview')
    }
  },
  '/cmty/admin/batch/run': {
    need: 'cmty.grant',
    run(b, c, d) {
      const by = { id: c.account.id, name: c.member?.nick || c.account.username }
      // 본문의 token 은 이미 인증 토큰 자리다. 미리보기 표는 다른 이름으로 받아야 서로 덮어쓰지 않는다.
      const r = d.econ.batchRun(by, s(b.previewToken, 64), c.now)
      if (!r.ok) return fail(r.error)
      c.audit('econ.batch', `${r.value.kind === 'grant' ? '지급' : '회수'} ${r.value.done}건 · 건너뜀 ${r.value.skipped} (${r.value.memo})`, {
        type: 'batch',
        id: r.value.id
      })
      // 인원이 많으면 개별 알림 대신 여기서 한 줄만 남긴다(알림 폭주 방지).
      return ok({ batch: r.value })
    }
  },
  '/cmty/admin/batch/undo': {
    need: 'cmty.grant',
    run(b, c, d) {
      const by = { id: c.account.id, name: c.member?.nick || c.account.username }
      const r = d.econ.batchUndo(by, s(b.batchId, 64), c.now)
      if (!r.ok) return fail(r.error)
      c.audit('econ.batch.undo', `${r.value.done}건 되돌림 · 건너뜀 ${r.value.skipped}`, { type: 'batch', id: r.value.id })
      return ok({ batch: r.value })
    }
  },
  '/cmty/admin/batch/list': {
    need: 'cmty.grant',
    run(_b, _c, d) {
      return ok({ batches: d.econ.batches() })
    }
  },

  '/cmty/admin/circulation': {
    need: 'cmty.viewStats',
    run(_b, _c, d) {
      return ok({ ...d.econ.circulation(), ledger: d.ledger.verify() })
    }
  }
}
