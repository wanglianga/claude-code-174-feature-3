import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  DispatchDept,
  DispatchKind,
  DispatchStatus,
  DispatchTask,
  DifficultyType,
  EvacuationRecord,
  FamilyProfile,
  House,
  HouseActivity,
  HouseStatus,
  IssueRecord,
  IssueStatus,
  IssueType,
  RainReport,
  RainTriageDecision,
  RectificationExtension,
  ReviewPlan,
  RiskEvent,
  RiskEventStatus,
  RiskLevel,
} from './entities';
import { CurrentUser } from './app.service';
import { evaluateRisk } from './risk.rules';

const RISK_RANK: Record<RiskLevel, number> = {
  [RiskLevel.NORMAL]: 0,
  [RiskLevel.RECTIFY]: 1,
  [RiskLevel.SUSPEND]: 2,
  [RiskLevel.EVACUATE]: 3,
};
const THREE_DAYS = 3 * 86400000;

// 正在整改期（含已出方案到验收前后、反弹）的房屋状态
const RECTIFYING_STATUSES = [
  HouseStatus.IN_PLAN,
  HouseStatus.NOTIFIED,
  HouseStatus.STOPPED,
  HouseStatus.EVACUATED,
  HouseStatus.RECTIFYING,
  HouseStatus.ACCEPTANCE_FAILED,
  HouseStatus.REBOUND,
];

@Injectable()
export class RainService {
  constructor(
    @InjectRepository(House) private houses: Repository<House>,
    @InjectRepository(RainReport) private rainReports: Repository<RainReport>,
    @InjectRepository(RiskEvent) private events: Repository<RiskEvent>,
    @InjectRepository(DispatchTask) private tasks: Repository<DispatchTask>,
    @InjectRepository(RectificationExtension) private extensions: Repository<RectificationExtension>,
    @InjectRepository(ReviewPlan) private plans: Repository<ReviewPlan>,
    @InjectRepository(FamilyProfile) private families: Repository<FamilyProfile>,
    @InjectRepository(HouseActivity) private activities: Repository<HouseActivity>,
  ) {}

  // ---------- 工具 ----------
  private async openEventOfHouse(houseId: string): Promise<RiskEvent | null> {
    const list = await this.events.find({
      where: { houseId, status: In([RiskEventStatus.ACTIVE, RiskEventStatus.TRIAGED, RiskEventStatus.EXTENDED, RiskEventStatus.EVACUATING]) },
      order: { lastReportAt: 'DESC' },
    });
    return list[0] || null;
  }

  private async latestPlan(houseId: string): Promise<ReviewPlan | null> {
    const list = await this.plans.find({ where: { houseId }, order: { reviewedAt: 'DESC' } });
    return list[0] || null;
  }

  /**
   * 判断本次暴雨上报是否真的需要重新上门。
   * 综合：本次险情等级、隐患是否较档案加重、是否处于整改期（含期限）、家庭困难与现场住人情况。
   */
  async screenNeedVisit(house: House, level: RiskLevel, body: any, fam: FamilyProfile | null) {
    const reasons: string[] = [];
    const worsened: string[] = [];
    if (Number(body.wallCrack || 0) > house.wallCrack) worsened.push(`墙体裂缝 ${house.wallCrack}→${body.wallCrack}`);
    if (Number(body.foundationSettlement || 0) > house.foundationSettlement) worsened.push(`地基沉降 ${house.foundationSettlement}→${body.foundationSettlement}`);
    if (Number(body.roofLeak || 0) > house.roofLeak) worsened.push(`屋面渗漏 ${house.roofLeak}→${body.roofLeak}`);

    const plan = await this.latestPlan(house.id);
    const inRectification = !!plan && RECTIFYING_STATUSES.includes(house.status);
    let deadlineNear = false;
    let deadlineOverdue = false;
    if (plan?.deadline) {
      const days = Math.ceil((new Date(plan.deadline).getTime() - Date.now()) / 86400000);
      deadlineNear = days <= 7;
      deadlineOverdue = days < 0;
    }
    const hasStructural = Number(body.wallCrack || 0) > 0 || Number(body.foundationSettlement || 0) > 0;
    const hasLeak = Number(body.roofLeak || 0) > 0;
    const isHardship = !!fam && fam.difficultyType !== DifficultyType.NONE;
    const residentsAtSite = Number(body.residentsAtSite ?? house.residents ?? 0);

    if (RISK_RANK[level] >= RISK_RANK[RiskLevel.SUSPEND]) reasons.push(`本次研判达${level === RiskLevel.EVACUATE ? '紧急转移' : '暂停使用'}级，须重新上门`);
    if (worsened.length) reasons.push(`隐患较原档案加重：${worsened.join('、')}`);
    if (inRectification && (hasStructural || Number(body.roofLeak || 0) === 2)) reasons.push('房屋尚在整改期，雨季后出现结构性隐患/严重渗漏，须现场复核整改进展');
    if (inRectification && deadlineOverdue) reasons.push('整改期限已过，须上门核查是否仍在施工');
    else if (inRectification && deadlineNear && (hasStructural || hasLeak)) reasons.push('整改期限临近（7日内），叠加新险情须上门核查');
    if (isHardship && residentsAtSite > 0 && (hasStructural || RISK_RANK[level] >= RISK_RANK[RiskLevel.RECTIFY])) {
      reasons.push(`困难家庭（${fam.difficultyType}）现场仍有 ${residentsAtSite} 人，优先上门并评估安置救助`);
    }
    const needVisit = reasons.length > 0;
    return { needVisit, reasons, worsened, inRectification, deadlineNear, deadlineOverdue, isHardship, plan };
  }

  /** 升级时自动派发村干部/住建/民政同一事件的处置任务 */
  private async dispatchEvacuationTasks(m: any, ev: RiskEvent, house: House, fam: FamilyProfile | null) {
    const mk = async (dept: DispatchDept, kind: DispatchKind, title: string, content: string, amount?: number) =>
      m.save(
        m.create(DispatchTask, {
          eventId: ev.id,
          houseId: house.id,
          dept,
          kind,
          title,
          content,
          status: DispatchStatus.PENDING,
          amount: amount != null ? amount.toFixed(2) : null,
        }),
      );

    await mk(
      DispatchDept.CADRE,
      DispatchKind.EVACUATE_ORGANIZE,
      '组织人员转移并现场盯守',
      `立即到户组织 ${house.residents} 名居住人员转移至安全安置点，落实老弱病残人员帮扶；转移后现场盯守、张贴警示，防止人员擅自返回。`,
    );
    await mk(
      DispatchDept.HOUSING,
      DispatchKind.RECTIFY_ADJUST,
      '紧急处置新增沉降/裂缝并调整整改方案',
      '对暴雨后新增地基沉降、墙体裂缝出具紧急处置意见，该房屋正在整改期，不重置原整改状态，在原方案基础上加固加严、调整施工安排。',
    );
    await mk(
      DispatchDept.HOUSING,
      DispatchKind.RECHECK_CLOSE,
      '处置后复查，合格后方可销号恢复等级',
      '转移与加固处置完成后组织复查，复查合格、各项处置任务办结后方可销号并恢复正常风险等级；不合格不得销号。',
    );
    await mk(
      DispatchDept.CIVIL,
      DispatchKind.TEMP_SETTLEMENT,
      '落实临时安置与基本生活保障',
      `协调村级/乡镇集中安置点或投亲靠友安置，落实过渡期生活保障；人员复查合格销号前不得返回。`,
    );
    if (fam && fam.difficultyType !== DifficultyType.NONE) {
      await mk(
        DispatchDept.CIVIL,
        DispatchKind.REPAIR_SUBSIDY,
        '困难家庭修缮补助/临时救助（与住建整改补助并行）',
        `该户为困难家庭（${fam.difficultyType}），在住建危房改造补助之外，同步启动民政临时救助与修缮补助通道，双线并行、不互相替代。`,
      );
    }
  }

  // ---------- 暴雨后险情上报 ----------
  async submitReport(u: CurrentUser, body: any) {
    if (!body.houseId) throw new BadRequestException('请选择上报房屋（接回原风险档案）');
    const house = await this.houses.findOne({ where: { id: body.houseId } });
    if (!house) throw new NotFoundException('房屋档案不存在');
    const fam = await this.families.findOne({ where: { houseId: house.id } });
    const level = evaluateRisk({
      buildYear: house.buildYear,
      floors: house.floors,
      isBusiness: house.isBusiness,
      isRented: house.isRented,
      isAddedFloor: house.isAddedFloor,
      wallCrack: Number(body.wallCrack || 0),
      roofLeak: Number(body.roofLeak || 0),
      foundationSettlement: Number(body.foundationSettlement || 0),
      residents: Number(body.residentsAtSite ?? house.residents ?? 0),
      rainSeason: true,
    });
    const reportedAt = body.reportedAt ? new Date(body.reportedAt) : new Date();
    const screening = await this.screenNeedVisit(house, level.level, body, fam);

    // 无需重新上门：只登记本次上报，不生成风险事件、不打扰处置人员
    if (!screening.needVisit) {
      const rec = await this.rainReports.save(
        this.rainReports.create({
          houseId: house.id,
          eventId: null,
          reporterId: u.sub,
          reporterName: u.name,
          reportedAt,
          wallCrack: Number(body.wallCrack || 0),
          roofLeak: Number(body.roofLeak || 0),
          foundationSettlement: Number(body.foundationSettlement || 0),
          residentsAtSite: Number(body.residentsAtSite ?? house.residents ?? 0),
          riskLevel: level.level,
          reasons: level.reasons,
          photos: body.photos || [],
          note: body.note || '',
          merged: false,
        }),
      );
      await this.activities.save(
        this.activities.create({
          houseId: house.id,
          kind: 'RAINEVENT',
          title: '暴雨后险情上报 · 系统筛选：暂不需重新上门',
          detail: `上报裂缝/渗漏/沉降=${rec.wallCrack}/${rec.roofLeak}/${rec.foundationSettlement}；纳入日常监测，原整改计划不变`,
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      return { needVisit: false, event: null, report: rec, screening };
    }

    return this.houses.manager.transaction(async (m) => {
      let ev = await this.openEventOfHouse(house.id);
      const isMerge = !!ev;
      const withinThreeDays = ev ? reportedAt.getTime() - new Date(ev.lastReportAt).getTime() <= THREE_DAYS : false;

      // 快照上次复查/整改结论
      const plan = screening.plan;
      const reviewSnapshot = plan
        ? `整改期内（期限 ${plan.deadline}），方案等级${plan.decision}，要求停用=${plan.stopUseRequired ? '是' : '否'}、转移=${plan.evacuationRequired ? '是' : '否'}`
        : (house.status === HouseStatus.CLOSED ? '此前已销号' : '尚无整改方案');

      if (!ev) {
        const seq = (await m.count(RiskEvent)) + 1;
        ev = m.create(RiskEvent, {
          code: `SJ-${String(seq).padStart(6, '0')}`,
          houseId: house.id,
          openedAt: reportedAt,
          lastReportAt: reportedAt,
          reportCount: 0,
          initialRiskLevel: level.level,
          riskLevel: level.level,
          previousRiskLevel: house.riskLevel,
          previousHouseStatus: house.status,
          deadlineSnapshot: plan?.deadline || null,
          lastReviewSnapshot: reviewSnapshot,
          status: RiskEventStatus.ACTIVE,
          autoDispatched: false,
          escalationLog: [],
        });
        ev = await m.save(ev);
      }

      // 同屋反复上报并入同一事件，三天窗口合并计数
      ev.reportCount += 1;
      ev.lastReportAt = reportedAt;
      const beforeLevel = ev.riskLevel;
      if (RISK_RANK[level.level] > RISK_RANK[ev.riskLevel]) {
        ev.riskLevel = level.level;
      }
      ev.escalationLog = [
        ...(ev.escalationLog || []),
        {
          at: reportedAt.toISOString(),
          riskLevel: level.level,
          action: isMerge ? (withinThreeDays ? '三天内重复上报，并入同一事件' : '事件未闭环，再次上报并入同一事件') : '首次上报，建立风险事件',
          note: screening.worsened.length ? `加重：${screening.worsened.join('、')}` : undefined,
        },
      ];

      // 变化接回原风险档案：隐患观测值与风险等级更新，治理状态保持不变（不重置整改）
      if (Number(body.wallCrack || 0) > 0) house.wallCrack = Number(body.wallCrack);
      if (Number(body.roofLeak || 0) > 0) house.roofLeak = Number(body.roofLeak);
      if (Number(body.foundationSettlement || 0) > 0) house.foundationSettlement = Number(body.foundationSettlement);
      if (body.residentsAtSite != null) house.residents = Number(body.residentsAtSite);
      if (RISK_RANK[ev.riskLevel] > RISK_RANK[house.riskLevel]) {
        house.riskLevel = ev.riskLevel;
        house.ruleReasons = level.reasons;
      }
      // 关键：不修改 house.status，正在整改的房屋不被新告警重置
      await m.save(house);

      const rec = await m.save(
        m.create(RainReport, {
          houseId: house.id,
          eventId: ev.id,
          reporterId: u.sub,
          reporterName: u.name,
          reportedAt,
          wallCrack: Number(body.wallCrack || 0),
          roofLeak: Number(body.roofLeak || 0),
          foundationSettlement: Number(body.foundationSettlement || 0),
          residentsAtSite: Number(body.residentsAtSite ?? house.residents ?? 0),
          riskLevel: level.level,
          reasons: level.reasons,
          photos: body.photos || [],
          note: body.note || '',
          merged: isMerge,
        }),
      );

      // 升级到转移级：自动派发村干部/住建/民政同一处置任务（仅一次）
      let dispatched = false;
      if (ev.riskLevel === RiskLevel.EVACUATE && !ev.autoDispatched) {
        await this.dispatchEvacuationTasks(m, ev, house, fam);
        ev.autoDispatched = true;
        dispatched = true;
      }
      await m.save(ev);

      // 雨季异常（非阻断）：同屋同类未办结则不重复开
      const openRain = await m.findOne(IssueRecord, {
        where: { houseId: house.id, type: IssueType.RAIN_SEASON, status: In([IssueStatus.OPEN, IssueStatus.RESOLVING]) },
      });
      if (!openRain) {
        await m.save(
          m.create(IssueRecord, {
            houseId: house.id,
            type: IssueType.RAIN_SEASON,
            description: `连续暴雨后新增险情（事件 ${ev.code}）：${screening.reasons.join('；')}`,
            status: IssueStatus.RESOLVING,
            blocksWorkflow: false,
            raisedById: u.sub,
            raisedByName: u.name,
            raisedAt: new Date(),
          }),
        );
      }

      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: 'RAINEVENT',
          title: isMerge
            ? `暴雨险情第 ${ev.reportCount} 次上报并入事件 ${ev.code}（${withinThreeDays ? '三天内' : '事件持续中'}，当前${riskText(ev.riskLevel)}）`
            : `暴雨后新增险情，建立风险事件 ${ev.code}（${riskText(ev.riskLevel)}）`,
          detail: [screening.reasons.join('；'), body.note].filter(Boolean).join('；'),
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      if (dispatched) {
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id,
            kind: 'RAINEVENT',
            title: `风险升至转移级，已向村干部、住建、民政同步派发处置任务（事件 ${ev.code}）`,
            detail: fam && fam.difficultyType !== DifficultyType.NONE ? '困难家庭：民政临时安置与修缮补助双通道并行' : '三方任务：转移盯守 / 方案调整与复查 / 临时安置',
            operatorId: u.sub,
            operatorName: u.name,
          }),
        );
      }

      return {
        needVisit: true,
        event: ev,
        report: rec,
        merged: isMerge,
        withinThreeDays,
        escalated: RISK_RANK[ev.riskLevel] > RISK_RANK[beforeLevel],
        dispatched,
        screening,
      };
    });
  }

  // ---------- 分流：继续原计划 / 延长整改 / 先转移 ----------
  async triage(u: CurrentUser, eventId: string, body: any) {
    const ev = await this.events.findOne({ where: { id: eventId } });
    if (!ev) throw new NotFoundException('风险事件不存在');
    if (ev.status === RiskEventStatus.CLOSED) throw new BadRequestException('事件已闭环，不能再分流');
    if (ev.status !== RiskEventStatus.ACTIVE) throw new BadRequestException('事件已分流，不能重复下达分流结论（按既定分流推进处置即可）');
    const decision: RainTriageDecision = body.decision;
    if (![RainTriageDecision.CONTINUE, RainTriageDecision.EXTEND, RainTriageDecision.EVACUATE].includes(decision)) {
      throw new BadRequestException('分流结论必须为：继续原计划 / 延长整改 / 先转移');
    }
    const house = await this.houses.findOne({ where: { id: ev.houseId } });
    if (!house) throw new NotFoundException('房屋档案不存在');

    // 已达转移级不允许"继续原计划"简单带过
    if (decision === RainTriageDecision.CONTINUE && ev.riskLevel === RiskLevel.EVACUATE) {
      throw new BadRequestException('事件已升至紧急转移级，不能按原计划继续，须先安排人员转移');
    }
    const plan = await this.latestPlan(house.id);

    return this.houses.manager.transaction(async (m) => {
      const fam = await m.findOne(FamilyProfile, { where: { houseId: house.id } });
      const log = [...(ev.escalationLog || [])];

      if (decision === RainTriageDecision.EXTEND) {
        if (!body.newDeadline) throw new BadRequestException('延长整改必须给出新的整改期限');
        if (!plan) throw new BadRequestException('该房屋尚无整改方案，无法延长整改期限');
        if (new Date(body.newDeadline) <= new Date(plan.deadline)) {
          throw new BadRequestException('新期限必须晚于原整改期限');
        }
        const oldDeadline = plan.deadline;
        await m.save(
          m.create(RectificationExtension, {
            houseId: house.id,
            planId: plan.id,
            eventId: ev.id,
            oldDeadline,
            newDeadline: body.newDeadline,
            reason: body.note || '暴雨后新增沉降渗漏，需在原整改基础上加固施工',
            byId: u.sub,
            byName: u.name,
          }),
        );
        plan.deadline = body.newDeadline;
        await m.save(plan);
        ev.status = RiskEventStatus.EXTENDED;
        log.push({ at: new Date().toISOString(), riskLevel: ev.riskLevel, action: `分流：延长整改期限 ${oldDeadline} → ${body.newDeadline}，原整改状态保留`, note: body.note });
        // 延长/继续时安排村干部加密监测（幂等：同事件同类型不重复派）
        await this.ensureMonitorTask(m, ev, house);
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id, kind: 'RAINEVENT',
            title: `事件 ${ev.code} 分流：延长整改期限至 ${body.newDeadline}`,
            detail: `原整改状态（${house.status}）与已完成工序保留，不重置；${body.note || ''}`,
            operatorId: u.sub, operatorName: u.name,
          }),
        );
      } else if (decision === RainTriageDecision.CONTINUE) {
        ev.status = RiskEventStatus.TRIAGED;
        log.push({ at: new Date().toISOString(), riskLevel: ev.riskLevel, action: '分流：险情可控，继续原整改计划，加密监测', note: body.note });
        await this.ensureMonitorTask(m, ev, house);
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id, kind: 'RAINEVENT',
            title: `事件 ${ev.code} 分流：继续原整改计划`,
            detail: `整改期限与措施不变（期限 ${plan?.deadline || '—'}），村级加密监测；${body.note || ''}`,
            operatorId: u.sub, operatorName: u.name,
          }),
        );
      } else {
        // 先转移：事件等级确认为转移级（人工判定可升级），自动派发三方任务
        if (RISK_RANK[ev.riskLevel] < RISK_RANK[RiskLevel.EVACUATE]) {
          ev.riskLevel = RiskLevel.EVACUATE;
          if (RISK_RANK[house.riskLevel] < RISK_RANK[RiskLevel.EVACUATE]) house.riskLevel = RiskLevel.EVACUATE;
          await m.save(house);
        }
        ev.status = RiskEventStatus.EVACUATING;
        log.push({ at: new Date().toISOString(), riskLevel: RiskLevel.EVACUATE, action: '分流：先安排人员转移，再调整加固施工', note: body.note });
        if (!ev.autoDispatched) {
          await this.dispatchEvacuationTasks(m, ev, house, fam);
          ev.autoDispatched = true;
        }
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id, kind: 'RAINEVENT',
            title: `事件 ${ev.code} 分流：先安排人员转移（村干部/住建/民政同步接单）`,
            detail: body.note || '',
            operatorId: u.sub, operatorName: u.name,
          }),
        );
      }

      ev.triageDecision = decision;
      ev.triageNote = body.note || '';
      ev.triagedById = u.sub;
      ev.triagedByName = u.name;
      ev.triagedAt = new Date();
      ev.escalationLog = log;
      await m.save(ev);
      return this.eventDetail(ev.id);
    });
  }

  private async ensureMonitorTask(m: any, ev: RiskEvent, house: House) {
    const exists = await m.findOne(DispatchTask, { where: { eventId: ev.id, kind: DispatchKind.MONITOR, cancelled: false } });
    if (exists) return;
    await m.save(
      m.create(DispatchTask, {
        eventId: ev.id,
        houseId: house.id,
        dept: DispatchDept.CADRE,
        kind: DispatchKind.MONITOR,
        title: '雨期加密巡查监测',
        content: '降雨期间每日至少巡查一次，盯守裂缝/沉降变化，发现加重立即在系统上报（将并入本事件持续升级）。',
        status: DispatchStatus.PENDING,
      }),
    );
  }

  // ---------- 处置任务办结 ----------
  private deptAllowedRoles(dept: DispatchDept) {
    if (dept === DispatchDept.CADRE) return ['CADRE', 'COUNTY_ADMIN'];
    if (dept === DispatchDept.HOUSING) return ['TOWNSHIP_REVIEWER', 'COUNTY_ADMIN', 'ACCEPTOR'];
    return ['CIVIL_ADMIN', 'COUNTY_ADMIN'];
  }

  async completeTask(u: CurrentUser, taskId: string, body: any) {
    const task = await this.tasks.findOne({ where: { id: taskId } });
    if (!task) throw new NotFoundException('处置任务不存在');
    if (!this.deptAllowedRoles(task.dept).includes(u.role)) {
      throw new ForbiddenException('该任务由其他部门负责，当前角色无权办结');
    }
    if (task.status === DispatchStatus.DONE) throw new BadRequestException('任务已办结，无需重复操作');
    if (task.cancelled) throw new BadRequestException('任务已撤销');

    const house = await this.houses.findOne({ where: { id: task.houseId } });
    if (!house) throw new NotFoundException('房屋档案不存在');
    // 乡镇住建、村干部只能处置本辖区任务（县级、民政、验收不限）
    if (u.township && u.role !== 'COUNTY_ADMIN' && house.township !== u.township) {
      throw new ForbiddenException('该任务不属于当前账号所辖乡镇');
    }
    if (!body.result) throw new BadRequestException('办结处置任务必须填写处置结果');

    return this.houses.manager.transaction(async (m) => {
      task.status = DispatchStatus.DONE;
      task.result = body.result;
      task.doneById = u.sub;
      task.doneByName = u.name;
      task.doneAt = new Date();
      if (body.amount != null) task.amount = Number(body.amount).toFixed(2);
      task.assigneeName = u.name;
      await m.save(task);

      const titles: Record<string, string> = {
        [DispatchDept.CADRE]: '村干部',
        [DispatchDept.HOUSING]: '住建',
        [DispatchDept.CIVIL]: '民政',
      };

      // 民政临时安置办结：同步生成人员转移安置记录（应急通道，不改房屋整改状态，返回仍须等销号）
      if (task.kind === DispatchKind.TEMP_SETTLEMENT) {
        const residents = Number(body.residents || house.residents || 0);
        const destination = body.destination || '民政临时安置点';
        await m.save(
          m.create(EvacuationRecord, {
            houseId: house.id,
            residents,
            destination,
            photos: body.photos || [],
            settledAt: new Date(),
            allowReturn: false,
            recorderId: u.sub,
            remark: `暴雨事件应急临时安置（${titles[task.dept]}办结）${body.amount != null ? `，安置/救助费用 ¥${Number(body.amount).toFixed(2)}` : ''}`,
          }),
        );
        house.stopUseConfirmed = true;
        await m.save(house);
      }

      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: 'RAINEVENT',
          title: `${titles[task.dept]}处置任务办结：${task.title}`,
          detail: body.result + (body.amount != null ? `；涉及金额 ¥${Number(body.amount).toFixed(2)}` : ''),
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      return task;
    });
  }

  // ---------- 查询 ----------
  async listEvents(query: any, u: CurrentUser) {
    const qb = this.events.createQueryBuilder('e').leftJoin(House, 'h', 'h.id::text = e."houseId"');
    if (query.status) qb.andWhere('e.status = :s', { s: query.status });
    if (query.riskLevel) qb.andWhere('e.riskLevel = :r', { r: query.riskLevel });
    if (query.houseId) qb.andWhere('e."houseId" = :hid', { hid: query.houseId });
    if (query.active === 'true' || query.active === true) {
      qb.andWhere('e.status != :c', { c: RiskEventStatus.CLOSED });
    }
    // 乡镇/村级账号只能看本乡镇
    const township = query.township || (u.role === 'TOWNSHIP_REVIEWER' || u.role === 'GRID_WORKER' || u.role === 'CADRE' ? u.township : undefined);
    if (township) qb.andWhere('h.township = :t', { t: township });
    qb.orderBy('e.lastReportAt', 'DESC');
    const rows = await qb.limit(Math.min(Number(query.limit) || 200, 500)).offset(Number(query.offset) || 0).getMany();

    const houseIds = [...new Set(rows.map((r) => r.houseId))];
    const houses = houseIds.length ? await this.houses.find({ where: { id: In(houseIds) } }) : [];
    const hmap = new Map(houses.map((h) => [h.id, h]));
    const taskRows = houseIds.length
      ? await this.tasks.createQueryBuilder('d').where('d."houseId" IN (:...ids)', { ids: houseIds }).andWhere('d.cancelled = false').getMany()
      : [];
    const pendingByEvent = new Map<string, number>();
    for (const t of taskRows) {
      if (t.status === DispatchStatus.PENDING) pendingByEvent.set(t.eventId, (pendingByEvent.get(t.eventId) || 0) + 1);
    }
    return {
      total: rows.length,
      data: rows.map((e) => {
        const h = hmap.get(e.houseId);
        return {
          ...e,
          house: h ? { id: h.id, code: h.code, township: h.township, village: h.village, ownerName: h.ownerName, address: h.address, status: h.status } : null,
          pendingTasks: pendingByEvent.get(e.id) || 0,
        };
      }),
    };
  }

  async eventDetail(eventId: string) {
    const ev = await this.events.findOne({ where: { id: eventId } });
    if (!ev) throw new NotFoundException('风险事件不存在');
    const [house, reports, dispatches, fam, extensions] = await Promise.all([
      this.houses.findOne({ where: { id: ev.houseId } }),
      this.rainReports.find({ where: { eventId }, order: { reportedAt: 'DESC' } }),
      this.tasks.find({ where: { eventId }, order: { createdAt: 'ASC' } }),
      this.families.findOne({ where: { houseId: ev.houseId } }),
      this.extensions.find({ where: { eventId }, order: { createdAt: 'DESC' } }),
    ]);
    const pending = dispatches.filter((d) => !d.cancelled && d.status === DispatchStatus.PENDING);
    return { event: ev, house, family: fam, reports, dispatches, extensions, pendingCount: pending.length, allDone: dispatches.filter((d) => !d.cancelled).length > 0 && pending.length === 0 };
  }

  /** 我的待办（按角色映射部门） */
  async myTasks(u: CurrentUser) {
    let depts: DispatchDept[];
    if (u.role === 'CADRE') depts = [DispatchDept.CADRE];
    else if (u.role === 'TOWNSHIP_REVIEWER' || u.role === 'ACCEPTOR') depts = [DispatchDept.HOUSING];
    else if (u.role === 'CIVIL_ADMIN') depts = [DispatchDept.CIVIL];
    else if (u.role === 'COUNTY_ADMIN') depts = [DispatchDept.CADRE, DispatchDept.HOUSING, DispatchDept.CIVIL];
    else depts = [];
    if (!depts.length) return { data: [] };
    const qb = this.tasks
      .createQueryBuilder('d')
      .leftJoin(House, 'h', 'h.id::text = d."houseId"')
      .leftJoin(RiskEvent, 'e', 'e.id::text = d."eventId"')
      .where('d.dept IN (:...depts)', { depts })
      .andWhere('d.cancelled = false')
      .orderBy('d.status', 'ASC')
      .addOrderBy('d.createdAt', 'DESC');
    if (u.township && u.role !== 'COUNTY_ADMIN') qb.andWhere('h.township = :t', { t: u.township });
    const rows = await qb.limit(300).getMany();
    const houseIds = [...new Set(rows.map((r) => r.houseId))];
    const eventIds = [...new Set(rows.map((r) => r.eventId))];
    const houses = houseIds.length ? await this.houses.find({ where: { id: In(houseIds) } }) : [];
    const events = eventIds.length ? await this.events.find({ where: { id: In(eventIds) } }) : [];
    const hmap = new Map(houses.map((h) => [h.id, h]));
    const emap = new Map(events.map((e) => [e.id, e]));
    return {
      data: rows.map((d) => ({
        ...d,
        house: hmap.get(d.houseId) ? {
          id: d.houseId, code: hmap.get(d.houseId).code, township: hmap.get(d.houseId).township,
          village: hmap.get(d.houseId).village, ownerName: hmap.get(d.houseId).ownerName,
        } : null,
        eventCode: emap.get(d.eventId)?.code,
      })),
    };
  }

  /** 销号前闸口：该屋未闭环事件的处置任务必须全部办结 */
  async assertTasksDoneForClose(houseId: string) {
    const openEvents = await this.events.find({
      where: { houseId, status: In([RiskEventStatus.ACTIVE, RiskEventStatus.TRIAGED, RiskEventStatus.EXTENDED, RiskEventStatus.EVACUATING]) },
    });
    if (!openEvents.length) return;
    const pending = await this.tasks.find({
      where: { eventId: In(openEvents.map((e) => e.id)), status: DispatchStatus.PENDING, cancelled: false },
    });
    if (pending.length) {
      const deptText = [...new Set(pending.map((p) => ({ CADRE: '村干部', HOUSING: '住建', CIVIL: '民政' }[p.dept])))].join('、');
      throw new BadRequestException(
        `暴雨风险事件尚有 ${pending.length} 项处置任务未完成（责任方：${deptText}），须复查合格、三方任务全部办结后才能销号`,
      );
    }
  }

  /** 销号成功：关闭事件，风险等级恢复正常 */
  async closeEventsForHouse(houseId: string, u?: CurrentUser, note?: string) {
    const openEvents = await this.events.find({
      where: { houseId, status: In([RiskEventStatus.ACTIVE, RiskEventStatus.TRIAGED, RiskEventStatus.EXTENDED, RiskEventStatus.EVACUATING]) },
    });
    if (openEvents.length) {
      const house = await this.houses.findOne({ where: { id: houseId } });
      if (house) {
        house.riskLevel = RiskLevel.NORMAL;
        house.ruleReasons = ['复查合格、整改完成，风险等级恢复正常，纳入日常关注'];
        await this.houses.save(house);
      }
    }
    for (const ev of openEvents) {
      ev.status = RiskEventStatus.CLOSED;
      ev.closedById = u?.sub || null;
      ev.closedByName = u?.name || null;
      ev.closedAt = new Date();
      ev.closeNote = note || '处置任务全部办结、复查合格并销号，事件闭环';
      ev.escalationLog = [...(ev.escalationLog || []), { at: new Date().toISOString(), riskLevel: RiskLevel.NORMAL, action: '复查合格销号，风险等级恢复正常，事件闭环' }];
      await this.events.save(ev);
      await this.activities.save(
        this.activities.create({
          houseId, kind: 'RAINEVENT',
          title: `事件 ${ev.code} 闭环：复查合格、销号，风险等级恢复正常`,
          detail: note || '',
          operatorId: u?.sub, operatorName: u?.name,
        }),
      );
    }
    return openEvents.length;
  }

  /** 销号后复查反弹：接回原档案并建立/重开风险事件（不自动派发，是否转移由分流决定） */
  async openReboundEvent(u: CurrentUser, house: House, body: any) {
    const { level, reasons } = evaluateRisk({
      buildYear: house.buildYear,
      floors: house.floors,
      isBusiness: house.isBusiness,
      isRented: house.isRented,
      isAddedFloor: house.isAddedFloor,
      wallCrack: Number(body.wallCrack || 0),
      roofLeak: Number(body.roofLeak || 0),
      foundationSettlement: Number(body.foundationSettlement || 0),
      residents: Number(body.residentsAtSite ?? house.residents ?? 0),
      rainSeason: true,
    });
    const now = new Date();
    let ev = await this.openEventOfHouse(house.id);
    if (!ev) {
      const seq = (await this.events.count()) + 1;
      ev = this.events.create({
        code: `SJ-${String(seq).padStart(6, '0')}`,
        houseId: house.id,
        trigger: '销号后复查发现问题反弹',
        openedAt: now,
        lastReportAt: now,
        reportCount: 0,
        initialRiskLevel: level,
        riskLevel: level,
        previousRiskLevel: house.riskLevel,
        previousHouseStatus: HouseStatus.CLOSED,
        lastReviewSnapshot: '销号后复查',
        status: RiskEventStatus.ACTIVE,
        autoDispatched: false,
        escalationLog: [],
      });
    }
    ev.reportCount += 1;
    ev.lastReportAt = now;
    if (RISK_RANK[level] > RISK_RANK[ev.riskLevel]) ev.riskLevel = level;
    ev.status = RiskEventStatus.ACTIVE;
    ev.escalationLog = [...(ev.escalationLog || []), {
      at: now.toISOString(), riskLevel: level, action: '销号后复查反弹，重新建立持续跟踪事件', note: body.reboundNotes,
    }];
    ev = await this.events.save(ev);

    await this.rainReports.save(
      this.rainReports.create({
        houseId: house.id,
        eventId: ev.id,
        reporterId: u.sub,
        reporterName: u.name,
        reportedAt: now,
        trigger: '销号后复查反弹',
        wallCrack: Number(body.wallCrack || 0),
        roofLeak: Number(body.roofLeak || 0),
        foundationSettlement: Number(body.foundationSettlement || 0),
        residentsAtSite: Number(body.residentsAtSite ?? house.residents ?? 0),
        riskLevel: level,
        reasons,
        note: `复查反弹：${body.reboundNotes || ''}`,
        merged: false,
      }),
    );
    return ev;
  }

  // ---------- 驾驶舱统计 ----------
  async stats(township?: string) {
    const eventQb = this.events.createQueryBuilder('e').leftJoin(House, 'h', 'h.id::text = e."houseId"');
    if (township) eventQb.andWhere('h.township = :t', { t: township });
    const allEvents = await eventQb.getMany();
    const byStatus: Record<string, number> = {};
    const byRisk: Record<string, number> = {};
    let active = 0, evacuating = 0, mergedReports = 0;
    for (const e of allEvents) {
      byStatus[e.status] = (byStatus[e.status] || 0) + 1;
      byRisk[e.riskLevel] = (byRisk[e.riskLevel] || 0) + 1;
      if (e.status !== RiskEventStatus.CLOSED) active++;
      if (e.status === RiskEventStatus.EVACUATING) evacuating++;
      mergedReports += Math.max(0, e.reportCount - 1);
    }

    const taskQb = this.tasks.createQueryBuilder('d').leftJoin(House, 'h', 'h.id::text = d."houseId"');
    if (township) taskQb.andWhere('h.township = :t', { t: township });
    const allTasks = await taskQb.getMany();
    const dispatchesByDept: Record<string, { pending: number; done: number }> = {};
    const civilAid = { settlementTasks: 0, settlementDone: 0, settlementAmount: 0, repairTasks: 0, repairDone: 0, repairAmount: 0 };
    for (const t of allTasks) {
      const k = dispatchesByDept[t.dept] || { pending: 0, done: 0 };
      if (t.cancelled) continue;
      if (t.status === DispatchStatus.PENDING) k.pending++;
      if (t.status === DispatchStatus.DONE) k.done++;
      dispatchesByDept[t.dept] = k;
      if (t.dept === DispatchDept.CIVIL && t.kind === DispatchKind.TEMP_SETTLEMENT) {
        civilAid.settlementTasks++;
        if (t.status === DispatchStatus.DONE) {
          civilAid.settlementDone++;
          civilAid.settlementAmount += Number(t.amount || 0);
        }
      }
      if (t.dept === DispatchDept.CIVIL && t.kind === DispatchKind.REPAIR_SUBSIDY) {
        civilAid.repairTasks++;
        if (t.status === DispatchStatus.DONE) {
          civilAid.repairDone++;
          civilAid.repairAmount += Number(t.amount || 0);
        }
      }
    }

    const reportQb = this.rainReports.createQueryBuilder('r').leftJoin(House, 'h', 'h.id::text = r."houseId"');
    if (township) reportQb.andWhere('h.township = :t', { t: township });
    const totalReports = await reportQb.getCount();
    const noVisitCount = await reportQb.andWhere('r."eventId" IS NULL').getCount();

    return {
      totalEvents: allEvents.length,
      totalReports,
      noVisitCount,
      activeEvents: active,
      evacuatingEvents: evacuating,
      mergedReports,
      eventsByStatus: byStatus,
      eventsByRisk: byRisk,
      dispatchesByDept,
      civilAid,
    };
  }
}

function riskText(l: RiskLevel) {
  return { NORMAL: '一般关注', RECTIFY: '限期整改', SUSPEND: '暂停使用', EVACUATE: '紧急转移' }[l] || l;
}
