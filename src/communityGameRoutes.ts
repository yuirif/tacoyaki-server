// 퀘스트·조사 라우트.
//
// 클라는 어떤 시각값도 보내지 않는다 — 파견은 '몇 분'만 보내고 끝나는 때는 서버가 만든다.
// 응답에 serverNow 를 실어 화면이 자기 시계와의 차이를 한 번 계산하게 한다.
// 그래야 접속자의 시계가 틀려 있어도 남은 시간이 어긋나지 않는다.
import { fail, from, n, ok, s, type Route } from './communityRouteKit'
import { sceneBrief } from './communitySurvey'

export const GAME_ROUTES: Record<string, Route> = {
  // ── 퀘스트 ──────────────────────────────────────────────────────────────
  '/cmty/quest/list': {
    need: 'member',
    run(b, c, d) {
      const boardId = s(b.boardId, 64)
      const staff = c.can('cmty.manageGames')
      return ok({
        quests: d.games.quests({ boardId: boardId || undefined, includeDisabled: staff }),
        runs: d.quest.runs(c.account.id, c.now),
        serverNow: c.now
      })
    }
  },

  '/cmty/quest/preview': {
    need: 'member',
    run(b, c, d) {
      const ids = (Array.isArray(b.charIds) ? b.charIds : []).filter((x): x is string => typeof x === 'string')
      const r = d.quest.preview(c.account.id, s(b.questId, 64), ids, c.now)
      return r.ok
        ? ok({ quest: r.value.quest, power: r.value.power, probs: r.value.probs, chars: r.value.chars, blocked: r.value.blocked, serverNow: c.now })
        : fail(r.error)
    }
  },

  '/cmty/quest/dispatch': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const ids = (Array.isArray(b.charIds) ? b.charIds : []).filter((x): x is string => typeof x === 'string')
      const r = d.quest.dispatch(c.account.id, s(b.questId, 64), ids, n(b.minutes, 30), c.now)
      return r.ok ? ok({ run: r.value, serverNow: c.now }) : fail(r.error)
    }
  },

  '/cmty/quest/claim': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.quest.claim(c.account.id, s(b.runId, 64), c.now)
      return r.ok ? ok({ run: r.value.run, gained: r.value.gained, pending: r.value.pending }) : fail(r.error)
    }
  },

  '/cmty/quest/cancel': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.quest.cancel(c.account.id, s(b.runId, 64), c.now)
      return from(r, 'run')
    }
  },

  // ── 조사 ────────────────────────────────────────────────────────────────
  '/cmty/survey/list': {
    need: 'member',
    run(b, c, d) {
      const boardId = s(b.boardId, 64)
      const staff = c.can('cmty.manageGames')
      const opts = { boardId: boardId || undefined, includeDisabled: staff }
      return ok({
        grids: d.games.grids(opts).map((g) => ({ id: g.id, name: g.name, desc: g.desc, image: g.image, rows: g.rows, cols: g.cols, version: g.version })),
        scenes: d.games.scenes(opts).map(sceneBrief),
        // 이어서 할 것이 있는지 첫 화면에서 보여 준다.
        running: Object.values(d.chars.meta(c.account.id).scenes)
          .filter((x) => !x.ended)
          .map((x) => ({ sceneId: x.sceneId, charId: x.charId, steps: x.steps }))
      })
    }
  },

  '/cmty/survey/grid': {
    need: 'member',
    run(b, c, d) {
      const r = d.survey.gridView(c.account.id, s(b.charId, 64), s(b.gridId, 64), c.now)
      return from(r, 'view')
    }
  },

  '/cmty/survey/open': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.survey.open(c.account.id, s(b.charId, 64), s(b.gridId, 64), n(b.row, -1), n(b.col, -1), c.now)
      return r.ok ? ok({ view: r.value.view, card: r.value.card, applied: r.value.applied, bonus: r.value.bonus }) : fail(r.error)
    }
  },

  '/cmty/scene/get': {
    need: 'member',
    run(b, c, d) {
      const r = d.survey.sceneView(c.account.id, s(b.charId, 64), s(b.sceneId, 64), c.now)
      return from(r, 'view')
    }
  },

  '/cmty/scene/start': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.survey.sceneStart(c.account.id, s(b.charId, 64), s(b.sceneId, 64), c.now)
      return from(r, 'view')
    }
  },

  '/cmty/scene/choose': {
    need: 'member',
    rate: 'econ',
    run(b, c, d) {
      const r = d.survey.sceneChoose(c.account.id, s(b.charId, 64), s(b.sceneId, 64), s(b.choiceId, 64), c.now)
      return r.ok
        ? ok({ view: r.value.view, applied: r.value.applied, ended: r.value.ended, endingLabel: r.value.endingLabel })
        : fail(r.error)
    }
  },

  '/cmty/scene/abandon': {
    need: 'member',
    run(b, c, d) {
      const r = d.survey.sceneAbandon(c.account.id, s(b.sceneId, 64))
      return r.ok ? ok() : fail(r.error)
    }
  },

  // ── 운영 ────────────────────────────────────────────────────────────────
  '/cmty/admin/quest/save': {
    need: 'cmty.manageGames',
    run(b, c, d) {
      const before = d.games.quest(s((b.quest as Record<string, unknown> | undefined)?.id, 64))
      const r = d.games.saveQuest(b.quest, c.now)
      if (r.ok) {
        // 확률표가 바뀌었으면 그 사실을 지문과 함께 남긴다 — 가장 의심받는 항목이다.
        const changed = before && before.tableHash !== r.value.tableHash
        c.audit('quest.save', changed ? `확률표 변경 ${before.tableHash} → ${r.value.tableHash}` : `${r.value.name} v${r.value.version}`, {
          type: 'quest',
          id: r.value.id,
          name: r.value.name
        })
      }
      return from(r, 'quest')
    }
  },
  '/cmty/admin/quest/remove': {
    need: 'cmty.manageGames',
    run(b, c, d) {
      const r = d.games.removeQuest(s(b.questId, 64), c.now)
      if (r.ok) c.audit('quest.remove', r.value.name, { type: 'quest', id: r.value.id, name: r.value.name })
      return from(r, 'quest')
    }
  },

  '/cmty/admin/grid/save': {
    need: 'cmty.manageGames',
    run(b, c, d) {
      const before = d.games.grid(s((b.grid as Record<string, unknown> | undefined)?.id, 64))
      const r = d.games.saveGrid(b.grid, c.now)
      if (r.ok) {
        const reset = before && before.epoch !== r.value.epoch
        const changed = before && before.tableHash !== r.value.tableHash
        c.audit(
          'grid.save',
          [reset ? '판 새로 깔기' : '', changed ? `확률표 변경 ${before?.tableHash} → ${r.value.tableHash}` : '', `${r.value.name} v${r.value.version}`]
            .filter(Boolean)
            .join(' · '),
          { type: 'grid', id: r.value.id, name: r.value.name }
        )
      }
      return from(r, 'grid')
    }
  },
  '/cmty/admin/grid/remove': {
    need: 'cmty.manageGames',
    run(b, c, d) {
      const r = d.games.removeGrid(s(b.gridId, 64), c.now)
      if (r.ok) c.audit('grid.remove', r.value.name, { type: 'grid', id: r.value.id, name: r.value.name })
      return from(r, 'grid')
    }
  },

  /** 고치려면 정의 전체가 필요하다 — 목록은 요약만 들고 있다. */
  '/cmty/admin/scene/get': {
    need: 'cmty.manageGames',
    run(b, _c, d) {
      const scene = d.games.scene(s(b.sceneId, 64))
      return scene ? ok({ scene }) : fail('조사를 찾을 수 없습니다.', 404)
    }
  },
  '/cmty/admin/grid/get': {
    need: 'cmty.manageGames',
    run(b, _c, d) {
      const grid = d.games.grid(s(b.gridId, 64))
      return grid ? ok({ grid }) : fail('조사판을 찾을 수 없습니다.', 404)
    }
  },

  '/cmty/admin/scene/check': {
    need: 'cmty.manageGames',
    run(b, _c, d) {
      // 저장하지 않고 검사만. 표를 붙여 넣은 직후 어디가 틀렸는지 먼저 보여 주기 위한 자리다.
      return ok({ issues: d.games.checkScene(b.scene) })
    }
  },
  '/cmty/admin/scene/save': {
    need: 'cmty.manageGames',
    run(b, c, d) {
      const r = d.games.saveScene(b.scene, c.now)
      if (r.ok) c.audit('scene.save', `${r.value.name} v${r.value.version} · 장면 ${r.value.nodes.length}`, { type: 'scene', id: r.value.id, name: r.value.name })
      return r.ok ? ok({ scene: r.value }) : fail(r.error, 400)
    }
  },
  '/cmty/admin/scene/remove': {
    need: 'cmty.manageGames',
    run(b, c, d) {
      const r = d.games.removeScene(s(b.sceneId, 64), c.now)
      if (r.ok) c.audit('scene.remove', r.value.name, { type: 'scene', id: r.value.id, name: r.value.name })
      return from(r, 'scene')
    }
  },

  /** 운영이 정의를 짤 때 필요한 재료 — 아이템 목록과 능력치 양식을 한 번에 준다. */
  '/cmty/admin/game/parts': {
    need: 'cmty.manageGames',
    run(_b, _c, d) {
      return ok({ items: d.catalog.items({ includeHidden: true }), schema: d.chars.schema(), boards: d.community.boards() })
    }
  }
}
