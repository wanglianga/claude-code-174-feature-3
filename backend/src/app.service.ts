import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  Acceptance,
  AcceptanceItemResult,
  AcceptanceResult,
  BudgetItem,
  CloseRecord,
  ConstructionLog,
  ConstructionPlan,
  ConstructionTeam,
  Consultation,
  DifficultyType,
  DispositionAssignee,
  DispositionTask,
  EvacuationRecord,
  FamilyProfile,
  House,
  HouseActivity,
  HouseStatus,
  Inspection,
  IssueRecord,
  IssueStatus,
  IssueType,
  ItemStatus,
  NoticeRecord,
  RainDisposition,
  RainEvent,
  RainEventStatus,
  RainReport,
  RainTaskStatus,
  RainTaskType,
  RectificationItem,
  RecheckRecord,
  ReviewPlan,
  RiskLevel,
  Stakeholder,
  SubsidyApplication,
  SubsidyStatus,
  User,
  UserRole,
} from './entities';
import { evaluateRisk } from './risk.rules';
import { RAIN_MERGE_WINDOW_MS, maxLevel, mergeRainReport, rankLevel, scoreRainCandidate } from './rain.rules';

const SUBSIDY_RATE = 0.7; // 补助不超过核定预算的70%
const SUBSIDY_CAP = 50000; // 每户最高修缮补助5万元
const EMERGENCY_AID_CAP = 10000; // 临时安置应急救助上限
const AID_KIND_RECTIFY = 'RECTIFY'; // 修缮补助
const AID_KIND_EMERGENCY = 'EMERGENCY'; // 临时安置救助

export interface CurrentUser {
  sub: string;
  username: string;
  name: string;
  role: string;
  township?: string;
  teamId?: string;
}

@Injectable()
export class AppService {
  constructor(
    @InjectRepository(House) private houses: Repository<House>,
    @InjectRepository(Inspection) private inspections: Repository<Inspection>,
    @InjectRepository(ReviewPlan) private plans: Repository<ReviewPlan>,
    @InjectRepository(RectificationItem) private items: Repository<RectificationItem>,
    @InjectRepository(NoticeRecord) private notices: Repository<NoticeRecord>,
    @InjectRepository(EvacuationRecord) private evacuations: Repository<EvacuationRecord>,
    @InjectRepository(Stakeholder) private stakeholders: Repository<Stakeholder>,
    @InjectRepository(Consultation) private consultations: Repository<Consultation>,
    @InjectRepository(IssueRecord) private issues: Repository<IssueRecord>,
    @InjectRepository(FamilyProfile) private families: Repository<FamilyProfile>,
    @InjectRepository(ConstructionTeam) private teams: Repository<ConstructionTeam>,
    @InjectRepository(ConstructionPlan) private cplans: Repository<ConstructionPlan>,
    @InjectRepository(BudgetItem) private budgetItems: Repository<BudgetItem>,
    @InjectRepository(SubsidyApplication) private subsidies: Repository<SubsidyApplication>,
    @InjectRepository(ConstructionLog) private logs: Repository<ConstructionLog>,
    @InjectRepository(Acceptance) private acceptances: Repository<Acceptance>,
    @InjectRepository(AcceptanceItemResult) private results: Repository<AcceptanceItemResult>,
    @InjectRepository(CloseRecord) private closes: Repository<CloseRecord>,
    @InjectRepository(RecheckRecord) private rechecks: Repository<RecheckRecord>,
    @InjectRepository(RainEvent) private rainEvents: Repository<RainEvent>,
    @InjectRepository(RainReport) private rainReports: Repository<RainReport>,
    @InjectRepository(DispositionTask) private rainTasks: Repository<DispositionTask>,
    @InjectRepository(DispositionAssignee) private rainAssignees: Repository<DispositionAssignee>,
    @InjectRepository(HouseActivity) private activities: Repository<HouseActivity>,
    @InjectRepository(User) private users: Repository<User>,
    private dataSource: DataSource,
  ) {}

  // ---------- 工具 ----------
  async logActivity(houseId: string, kind: string, title: string, detail: string, u?: CurrentUser) {
    await this.activities.save(
      this.activities.create({
        houseId,
        kind,
        title,
        detail,
        operatorId: u?.sub,
        operatorName: u?.name,
      }),
    );
  }

  async openBlockingIssues(houseId: string): Promise<IssueRecord[]> {
    return this.issues.find({ where: { houseId, blocksWorkflow: true, status: In([IssueStatus.OPEN, IssueStatus.RESOLVING]) } });
  }

  async assertNoBlocking(houseId: string, action: string) {
    const list = await this.openBlockingIssues(houseId);
    if (list.length) {
      throw new BadRequestException(
        `存在 ${list.length} 件未解决的阻断性问题（${list.map((i) => issueTypeLabel(i.type)).join('、')}），无法${action}；请先协商处理并办结`,
      );
    }
  }

  async getHouseOrFail(id: string) {
    const h = await this.houses.findOne({ where: { id } });
    if (!h) throw new NotFoundException('房屋档案不存在');
    return h;
  }

  async latestPlan(houseId: string) {
    const plans = await this.plans.find({ where: { houseId }, order: { reviewedAt: 'DESC' }, relations: ['items'] });
    return plans[0] || null;
  }

  // ---------- 巡查 ----------
  async createInspection(u: CurrentUser, body: any) {
    const required = ['township', 'village', 'address', 'ownerName', 'buildYear', 'floors'];
    for (const f of required) {
      if (body[f] === undefined || body[f] === null || body[f] === '') {
        throw new BadRequestException(`字段 ${f} 不能为空`);
      }
    }
    const { level, reasons } = evaluateRisk({
      buildYear: Number(body.buildYear),
      floors: Number(body.floors),
      isBusiness: !!body.isBusiness,
      isRented: !!body.isRented,
      isAddedFloor: !!body.isAddedFloor,
      wallCrack: Number(body.wallCrack || 0),
      roofLeak: Number(body.roofLeak || 0),
      foundationSettlement: Number(body.foundationSettlement || 0),
      residents: Number(body.residents || 0),
      rainSeason: !!body.rainSeason,
    });

    return this.dataSource.transaction(async (m) => {
      let house: House;
      if (body.houseId) {
        house = await m.findOne(House, { where: { id: body.houseId } });
        if (!house) throw new NotFoundException('房屋档案不存在');
      } else if (body.code) {
        house = await m.findOne(House, { where: { code: body.code } });
      }
      if (!house) {
        const code = body.code || `NF-${body.township.slice(0, 2)}-${Date.now().toString().slice(-6)}`;
        if (await m.findOne(House, { where: { code } })) throw new BadRequestException('档案编号已存在');
        house = m.create(House, { code });
      }
      Object.assign(house, {
        township: body.township,
        village: body.village,
        address: body.address,
        lng: body.lng ?? house.lng,
        lat: body.lat ?? house.lat,
        ownerName: body.ownerName,
        idCard: body.idCard ?? house.idCard,
        ownerPhone: body.ownerPhone ?? house.ownerPhone,
        buildYear: Number(body.buildYear),
        floors: Number(body.floors),
        usage: body.usage || '住宅',
        isBusiness: !!body.isBusiness,
        isRented: !!body.isRented,
        isAddedFloor: !!body.isAddedFloor,
        wallCrack: Number(body.wallCrack || 0),
        roofLeak: Number(body.roofLeak || 0),
        foundationSettlement: Number(body.foundationSettlement || 0),
        residents: Number(body.residents || 0),
        riskLevel: level,
        ruleReasons: reasons,
      });
      // 复查中反弹的房屋再次巡查且有风险 -> 重新进入待复核；已销号房屋巡查出新风险 -> 待复核
      if ([HouseStatus.CLOSED, HouseStatus.REBOUND].includes(house.status) && level !== RiskLevel.NORMAL) {
        house.status = HouseStatus.PENDING_REVIEW;
      } else if (!house.status || house.status === HouseStatus.CLOSED) {
        house.status = HouseStatus.PENDING_REVIEW;
      }
      house = await m.save(house);

      const insp = await m.save(
        m.create(Inspection, {
          houseId: house.id,
          inspectorId: u.sub,
          inspectorName: u.name,
          inspectedAt: body.inspectedAt ? new Date(body.inspectedAt) : new Date(),
          buildYear: house.buildYear,
          floors: house.floors,
          usage: house.usage,
          isBusiness: house.isBusiness,
          isRented: house.isRented,
          isAddedFloor: house.isAddedFloor,
          wallCrack: house.wallCrack,
          roofLeak: house.roofLeak,
          foundationSettlement: house.foundationSettlement,
          residents: house.residents,
          rainSeason: !!body.rainSeason,
          riskLevel: level,
          reasons,
          photos: body.photos || [],
          notes: body.notes || null,
        }),
      );

      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: 'INSPECTION',
          title: `巡查登记 · ${riskLabel(level)}`,
          detail: reasons.join('；'),
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      if (body.rainSeason && (level === RiskLevel.SUSPEND || level === RiskLevel.EVACUATE)) {
        await m.save(
          m.create(IssueRecord, {
            houseId: house.id,
            type: IssueType.RAIN_SEASON,
            description: '雨季/强降雨后房屋险情加重，需加密监测并优先处置',
            status: IssueStatus.RESOLVING,
            blocksWorkflow: false, // 雨季是加严因素而非整改阻断项
            raisedById: u.sub,
            raisedByName: u.name,
            raisedAt: new Date(),
          }),
        );
      }
      return { house, inspection: insp };
    });
  }

  // ---------- 乡镇复核与整改方案 ----------
  async createReview(u: CurrentUser, body: any) {
    const insp = await this.inspections.findOne({ where: { id: body.inspectionId } });
    if (!insp) throw new BadRequestException('巡查记录不存在');
    const house = await this.getHouseOrFail(insp.houseId);
    if (![HouseStatus.PENDING_REVIEW, HouseStatus.REBOUND].includes(house.status)) {
      throw new BadRequestException('当前房屋状态不允许复核（仅待复核/反弹重新治理可复核）');
    }
    if (!body.items || !body.items.length) throw new BadRequestException('整改方案至少包含一个整改项');
    const decision: RiskLevel = body.decision || insp.riskLevel;

    return this.dataSource.transaction(async (m) => {
      const plan = await m.save(
        m.create(ReviewPlan, {
          houseId: house.id,
          inspectionId: insp.id,
          reviewerId: u.sub,
          reviewerName: u.name,
          reviewedAt: new Date(),
          decision,
          requirement: body.requirement || '',
          deadline: body.deadline,
          stopUseRequired: !!body.stopUseRequired || decision === RiskLevel.SUSPEND || decision === RiskLevel.EVACUATE,
          evacuationRequired: !!body.evacuationRequired || decision === RiskLevel.EVACUATE,
        }),
      );
      for (const it of body.items) {
        await m.save(
          m.create(RectificationItem, {
            planId: plan.id,
            type: it.type,
            description: it.description,
            required: it.required !== false,
            status: ItemStatus.PENDING,
          }),
        );
      }
      house.status = HouseStatus.IN_PLAN;
      house.riskLevel = decision;
      await m.save(house);
      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: 'REVIEW',
          title: `乡镇复核 · ${riskLabel(decision)}，下达整改方案（${body.items.length}项，期限 ${body.deadline}）`,
          detail: body.requirement || '',
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      return m.findOne(ReviewPlan, { where: { id: plan.id }, relations: ['items'] });
    });
  }

  // ---------- 风险告知 ----------
  async createNotice(u: CurrentUser, body: any) {
    const house = await this.getHouseOrFail(body.houseId);
    const plan = await this.latestPlan(house.id);
    if (!plan) throw new BadRequestException('尚未形成复核整改方案，不能进行风险告知');
    if (!body.notifiedTo || !body.notifiedTo.length) throw new BadRequestException('请选择被告知对象');
    // 紧急转移/暂停使用房屋，告知必须签收，方可进入后续环节
    if ((plan.evacuationRequired || plan.stopUseRequired) && !body.acknowledged) {
      throw new BadRequestException('该房屋需暂停使用/紧急转移，风险告知必须由被告知人签收确认');
    }
    const notice = await this.notices.save(
      this.notices.create({
        houseId: house.id,
        planId: plan.id,
        method: body.method || '现场告知',
        notifiedTo: body.notifiedTo,
        notifiedAt: new Date(body.notifiedAt || Date.now()),
        acknowledged: !!body.acknowledged,
        signPhotos: body.signPhotos || [],
        content: body.content || plan.requirement,
        recorderId: u.sub,
      }),
    );
    house.status = HouseStatus.NOTIFIED;
    await this.houses.save(house);
    await this.logActivity(house.id, 'NOTICE', `风险告知（${notice.method}）`, `被告知人：${body.notifiedTo.join('、')}；${body.acknowledged ? '已签收' : '未签收'}`, u);
    return notice;
  }

  // ---------- 停用确认 / 人员转移 ----------
  async confirmStopUse(u: CurrentUser, houseId: string, body: any) {
    const house = await this.getHouseOrFail(houseId);
    const plan = await this.latestPlan(houseId);
    if (!plan) throw new BadRequestException('尚未下达整改方案');
    if (!plan.stopUseRequired && !plan.evacuationRequired) {
      throw new BadRequestException('方案未要求暂停使用，无需封停确认');
    }
    const ackNotice = await this.notices.findOne({ where: { houseId }, order: { notifiedAt: 'DESC' } });
    if (!ackNotice || !ackNotice.acknowledged) {
      throw new BadRequestException('风险告知未签收，不得采取封停措施');
    }
    house.stopUseConfirmed = !!body.confirmed;
    if (!plan.evacuationRequired) house.status = HouseStatus.STOPPED;
    await this.houses.save(house);
    await this.logActivity(houseId, 'NOTICE', body.confirmed ? '房屋已封停/设置警示，确认暂停使用' : '停用确认被撤销', body.remark || '', u);
    return { ok: true };
  }

  async createEvacuation(u: CurrentUser, body: any) {
    const house = await this.getHouseOrFail(body.houseId);
    const plan = await this.latestPlan(house.id);
    if (!plan) throw new BadRequestException('尚未下达整改方案');
    if (!plan.evacuationRequired && !body.force) {
      throw new BadRequestException('该房屋方案未要求紧急转移；如情况紧急请由乡镇确认后登记');
    }
    if (Number(body.residents) <= 0) throw new BadRequestException('转移人数必须大于0');
    if (!body.destination) throw new BadRequestException('请填写安置去向');
    const ackNotice = await this.notices.findOne({ where: { houseId: house.id }, order: { notifiedAt: 'DESC' } });
    if (!ackNotice?.acknowledged && !body.force) {
      throw new BadRequestException('风险告知未签收，不能登记转移（特殊情况可由乡镇强制处置并注明）');
    }
    return this.dataSource.transaction(async (m) => {
      const rec = await m.save(
        m.create(EvacuationRecord, {
          houseId: house.id,
          residents: Number(body.residents),
          destination: body.destination,
          photos: body.photos || [],
          settledAt: new Date(body.settledAt || Date.now()),
          allowReturn: false,
          rainEventId: body.rainEventId || null,
          recorderId: u.sub,
          remark: body.remark || '',
        }),
      );
      house.status = HouseStatus.EVACUATED;
      house.stopUseConfirmed = true;
      await m.save(house);
      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: 'EVACUATE',
          title: `紧急转移安置 ${rec.residents} 人 → ${rec.destination}`,
          detail: '验收通过并销号前，转移人员不得擅自返回',
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      return rec;
    });
  }

  // ---------- 利益相关方 / 协商 / 异常 ----------
  async upsertStakeholder(houseId: string, body: any) {
    const rec = body.id
      ? await this.stakeholders.findOne({ where: { id: body.id } })
      : this.stakeholders.create({ houseId });
    if (!rec) throw new NotFoundException();
    Object.assign(rec, {
      type: body.type,
      name: body.name,
      phone: body.phone,
      stance: body.stance,
      influenceNote: body.influenceNote,
    });
    return this.stakeholders.save(rec);
  }

  async createConsultation(u: CurrentUser, body: any) {
    if (!body.outcome) throw new BadRequestException('请记录协商结果');
    const c = await this.consultations.save(
      this.consultations.create({
        houseId: body.houseId,
        topic: body.topic || '整改进度协商',
        attendeeIds: body.attendeeIds || [],
        outcome: body.outcome,
        heldAt: new Date(body.heldAt || Date.now()),
        recorderId: u.sub,
      }),
    );
    await this.logActivity(body.houseId, 'CONSULT', `多方协商：${c.topic}`, body.outcome, u);
    return c;
  }

  async raiseIssue(u: CurrentUser, body: any) {
    if (!body.type || !body.description) throw new BadRequestException('问题类型和描述不能为空');
    const issue = await this.issues.save(
      this.issues.create({
        houseId: body.houseId,
        type: body.type,
        description: body.description,
        status: IssueStatus.OPEN,
        blocksWorkflow: body.blocksWorkflow !== false,
        raisedById: u.sub,
        raisedByName: u.name,
        raisedAt: new Date(),
      }),
    );
    await this.logActivity(body.houseId, 'ISSUE', `异常上报：${issueTypeLabel(body.type)}`, body.description, u);
    return issue;
  }

  async setIssueStatus(u: CurrentUser, id: string, status: IssueStatus, resolution?: string) {
    const issue = await this.issues.findOne({ where: { id } });
    if (!issue) throw new NotFoundException();
    if (status === IssueStatus.RESOLVED && !resolution) {
      throw new BadRequestException('办结问题必须填写处置结果');
    }
    issue.status = status;
    if (resolution) issue.resolution = resolution;
    if (status === IssueStatus.RESOLVED) issue.resolvedAt = new Date();
    await this.issues.save(issue);
    await this.logActivity(
      issue.houseId,
      'ISSUE',
      status === IssueStatus.RESOLVED ? `问题办结：${issueTypeLabel(issue.type)}` : `问题处理中：${issueTypeLabel(issue.type)}`,
      resolution || '',
      u,
    );
    return issue;
  }

  // ---------- 家庭与权属 ----------
  async upsertFamily(houseId: string, body: any) {
    let f = await this.families.findOne({ where: { houseId } });
    if (!f) f = this.families.create({ houseId });
    Object.assign(f, {
      difficultyType: body.difficultyType || DifficultyType.NONE,
      difficultyProof: body.difficultyProof || [],
      ownershipType: body.ownershipType || '自有',
      ownershipProof: body.ownershipProof || [],
      ownerConsent: !!body.ownerConsent,
      membersNote: body.membersNote || '',
    });
    return this.families.save(f);
  }

  // ---------- 施工队 ----------
  listTeams() {
    return this.teams.find();
  }
  async createTeam(body: any) {
    if (!body.name) throw new BadRequestException('施工队名称不能为空');
    const t = this.teams.create({
      name: body.name,
      qualificationNo: body.qualificationNo || '',
      qualificationDoc: body.qualificationDoc || [],
      qualified: !!body.qualified,
      contact: body.contact,
      phone: body.phone,
      scope: body.scope,
    });
    return this.teams.save(t);
  }

  // ---------- 施工计划与预算 ----------
  async submitConstructionPlan(u: CurrentUser, body: any) {
    const house = await this.getHouseOrFail(body.houseId);
    const plan = await this.latestPlan(house.id);
    if (!plan) throw new BadRequestException('乡镇尚未形成整改方案');
    await this.assertNoBlocking(house.id, '提交施工计划');

    // 告知制约
    const notice = await this.notices.findOne({ where: { houseId: house.id }, order: { notifiedAt: 'DESC' } });
    if (!notice) throw new BadRequestException('尚未进行风险告知，不能开工');
    if ((plan.stopUseRequired || plan.evacuationRequired) && !notice.acknowledged) {
      throw new BadRequestException('风险告知未签收，不能开工');
    }
    // 停用/转移制约
    if (plan.evacuationRequired) {
      const evac = await this.evacuations.findOne({ where: { houseId: house.id }, order: { settledAt: 'DESC' } });
      if (!evac) throw new BadRequestException('紧急转移尚未落实，不能开工');
    } else if (plan.stopUseRequired && !house.stopUseConfirmed) {
      throw new BadRequestException('房屋尚未确认停用，不能开工');
    }
    // 户主同意
    const fam = await this.families.findOne({ where: { houseId: house.id } });
    if (!fam?.ownerConsent) throw new BadRequestException('户主尚未签署整改同意书（家庭情况登记中确认）');

    // 施工队资质
    const team = await this.teams.findOne({ where: { id: body.teamId } });
    if (!team) throw new BadRequestException('请选择施工队');
    if (!team.qualified || !team.qualificationNo) {
      throw new BadRequestException(`施工队「${team.name}」资质无效或已过期，不得承担农房加固施工`);
    }

    // 预算明细
    if (!body.budgetItems || !body.budgetItems.length) throw new BadRequestException('请填写预算明细');
    let total = 0;
    for (const b of body.budgetItems) {
      if (!b.name || !(Number(b.qty) > 0) || !(Number(b.unitPrice) >= 0)) {
        throw new BadRequestException('预算明细存在空项或非法数量/单价');
      }
      total += Number(b.qty) * Number(b.unitPrice);
    }

    return this.dataSource.transaction(async (m) => {
      let cplan = await m.findOne(ConstructionPlan, { where: { houseId: house.id } });
      if (cplan) {
        await m.delete(BudgetItem, { planId: cplan.id });
      } else {
        cplan = m.create(ConstructionPlan, { houseId: house.id });
      }
      cplan.teamId = team.id;
      cplan.teamName = team.name;
      cplan.startDate = body.startDate;
      cplan.endDate = body.endDate;
      cplan.budgetTotal = total.toFixed(2);
      cplan.description = body.description || '';
      cplan = await m.save(cplan);
      for (const b of body.budgetItems) {
        const amount = Number(b.qty) * Number(b.unitPrice);
        await m.save(
          m.create(BudgetItem, {
            planId: cplan.id,
            name: b.name,
            spec: b.spec || '',
            qty: Number(b.qty),
            unit: b.unit,
            unitPrice: Number(b.unitPrice).toFixed(2),
            amount: amount.toFixed(2),
          }),
        );
      }
      house.status = HouseStatus.RECTIFYING;
      await m.save(house);
      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: 'PLAN',
          title: `施工计划与预算已提交（施工队：${team.name}，预算 ¥${total.toFixed(2)}）`,
          detail: `工期 ${body.startDate} 至 ${body.endDate}；共 ${body.budgetItems.length} 项明细`,
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      return m.findOne(ConstructionPlan, { where: { id: cplan.id }, relations: ['budgetItems'] });
    });
  }

  // ---------- 补助申请（资格校验闸）----------
  async computeSubsidyGuards(house: House): Promise<{ passed: boolean; label: string; ok: boolean; message: string }[]> {
    const fam = await this.families.findOne({ where: { houseId: house.id } });
    const cplan = await this.cplans.findOne({ where: { houseId: house.id }, relations: ['budgetItems'] });
    const plan = await this.latestPlan(house.id);
    const notice = await this.notices.findOne({ where: { houseId: house.id }, order: { notifiedAt: 'DESC' } });
    const team = cplan?.teamId ? await this.teams.findOne({ where: { id: cplan.teamId } }) : null;
    const budget = cplan ? Number(cplan.budgetTotal) : 0;

    const guards = [
      {
        label: '家庭困难类型',
        ok: !!fam && fam.difficultyType !== DifficultyType.NONE,
        message: !fam ? '未登记家庭情况' : fam.difficultyType === DifficultyType.NONE ? '未认定困难类型，不符合补助条件' : `已认定：${difficultyLabel(fam.difficultyType)}`,
      },
      {
        label: '困难证明材料',
        ok: !!fam && (fam.difficultyProof?.length || 0) > 0,
        message: fam?.difficultyProof?.length ? `已上传 ${fam.difficultyProof.length} 份` : '缺少民政部门困难证明',
      },
      {
        label: '房屋权属证明',
        ok: !!fam && (fam.ownershipProof?.length || 0) > 0,
        message: fam?.ownershipProof?.length ? `已上传 ${fam.ownershipProof.length} 份` : '缺少不动产权证/宅基地使用证明',
      },
      {
        label: '户主整改同意',
        ok: !!fam?.ownerConsent,
        message: fam?.ownerConsent ? '户主已签署同意书' : '户主尚未同意整改',
      },
      {
        label: '整改方案与告知',
        ok: !!plan && !!notice,
        message: plan ? (notice ? '方案已下达并已告知' : '方案已下达但尚未告知') : '乡镇尚未下达整改方案',
      },
      {
        label: '高风险房屋停用/转移',
        ok: !plan || ((!plan.stopUseRequired || house.stopUseConfirmed) && (!plan.evacuationRequired ? true : false)) ||
          (plan.evacuationRequired && !!(await this.evacuations.findOne({ where: { houseId: house.id } }))),
        message: !plan?.evacuationRequired ? (plan?.stopUseRequired ? (house.stopUseConfirmed ? '已确认停用' : '应停用但未确认停用') : '方案未要求停用') : (await this.evacuations.findOne({ where: { houseId: house.id } })) ? '人员已转移安置' : '应紧急转移但尚未安置',
      },
      {
        label: '预算明细',
        ok: !!cplan && cplan.budgetItems.length > 0 && budget > 0,
        message: cplan ? (cplan.budgetItems.length ? `预算 ${cplan.budgetItems.length} 项，合计 ¥${budget.toFixed(2)}` : '预算明细为空') : '未提交施工预算',
      },
      {
        label: '施工队资质',
        ok: !!team?.qualified && !!team?.qualificationNo,
        message: team ? (team.qualified ? `${team.name}（资质 ${team.qualificationNo}）` : `${team.name} 资质失效`) : '未选定施工队',
      },
    ];
    return guards.map((g) => ({ ...g, passed: g.ok }));
  }

  async submitSubsidy(u: CurrentUser, houseId: string, body: any) {
    const house = await this.getHouseOrFail(houseId);
    const aidKind = body.aidKind === AID_KIND_EMERGENCY ? AID_KIND_EMERGENCY : AID_KIND_RECTIFY;

    if (aidKind === AID_KIND_EMERGENCY) {
      return this.submitEmergencyAid(u, house, body);
    }

    const guards = await this.computeSubsidyGuards(house);
    const allPass = guards.every((g) => g.ok);
    const cplan = await this.cplans.findOne({ where: { houseId } });
    const budget = cplan ? Number(cplan.budgetTotal) : 0;
    const maxAmount = Math.min(Math.round(budget * SUBSIDY_RATE), SUBSIDY_CAP);
    const amount = Math.min(Number(body.amount || 0), maxAmount);

    let app = await this.subsidies.findOne({ where: { houseId, aidKind: AID_KIND_RECTIFY } });
    if (!app) app = this.subsidies.create({ houseId, aidKind: AID_KIND_RECTIFY });
    app.amount = amount.toFixed(2);
    app.difficultyType = body.difficultyType || app.difficultyType || DifficultyType.NONE;
    app.guardResults = guards;
    app.planId = (await this.latestPlan(houseId))?.id;
    app.status = allPass ? SubsidyStatus.SUBMITTED : SubsidyStatus.DRAFT;
    app.reviewComment = allPass ? null : '资格校验未全部通过，退回补充材料';
    app = await this.subsidies.save(app);

    await this.logActivity(
      houseId,
      'SUBSIDY',
      allPass ? `修缮补助申请已提交（¥${amount.toFixed(2)}，待乡镇复核）` : '修缮补助资格校验未通过，退回补充',
      guards.filter((g) => !g.ok).map((g) => `${g.label}：${g.message}`).join('；') || '全部校验通过',
      u,
    );
    return { application: app, allPass, maxAmount };
  }

  /** 临时安置应急救助（民政通道）：困难家庭 + 已触发转移级雨后事件（或方案要求转移且已安置） */
  private async submitEmergencyAid(u: CurrentUser, house: House, body: any) {
    const fam = await this.families.findOne({ where: { houseId: house.id } });
    const evacEvent = await this.rainEvents.findOne({
      where: { houseId: house.id, disposition: RainDisposition.EVACUATE },
      order: { lastReportAt: 'DESC' },
    });
    const plan = await this.latestPlan(house.id);
    const evacuated = !!(await this.evacuations.findOne({ where: { houseId: house.id } }));
    const eligibleEvent = !!(evacEvent || (plan?.evacuationRequired && evacuated));

    const guards = [
      {
        label: '困难家庭认定',
        ok: !!fam && fam.difficultyType !== DifficultyType.NONE,
        message: !fam ? '未登记家庭情况' : fam.difficultyType === DifficultyType.NONE ? '非困难家庭，临时安置救助须符合民政救助条件' : `已认定：${difficultyLabel(fam.difficultyType)}`,
      },
      {
        label: '困难证明材料',
        ok: !!fam && (fam.difficultyProof?.length || 0) > 0,
        message: fam?.difficultyProof?.length ? `已上传 ${fam.difficultyProof.length} 份` : '缺少民政部门困难证明',
      },
      {
        label: '人员转移已落实',
        ok: eligibleEvent,
        message: evacEvent ? '雨后事件已决定先转移人员，安置任务由民政/村干部落实' : plan?.evacuationRequired ? (evacuated ? '人员已转移安置' : '应紧急转移但尚未安置') : '未达到转移级险情，不适用临时安置救助',
      },
    ].map((g) => ({ ...g, passed: g.ok }));
    const allPass = guards.every((g) => g.ok);
    const amount = Math.min(Number(body.amount || 0), EMERGENCY_AID_CAP);

    let app = await this.subsidies.findOne({ where: { houseId: house.id, aidKind: AID_KIND_EMERGENCY } });
    if (!app) app = this.subsidies.create({ houseId: house.id, aidKind: AID_KIND_EMERGENCY });
    app.amount = amount.toFixed(2);
    app.difficultyType = fam?.difficultyType || DifficultyType.NONE;
    app.guardResults = guards;
    app.rainEventId = evacEvent?.id || app.rainEventId || null;
    app.planId = plan?.id || app.planId || null;
    app.status = allPass ? SubsidyStatus.SUBMITTED : SubsidyStatus.DRAFT;
    app.reviewComment = allPass ? null : '临时安置救助资格校验未全部通过，退回补充';
    if (evacEvent) {
      app.rainEventId = evacEvent.id;
      const civilTask = await this.rainTasks.findOne({ where: { eventId: evacEvent.id, taskType: RainTaskType.CIVIL_AFFAIRS } });
      if (civilTask) app.taskId = civilTask.id;
    }
    app = await this.subsidies.save(app);

    await this.logActivity(
      house.id,
      'SUBSIDY',
      allPass ? `临时安置救助申请已提交（¥${amount.toFixed(2)}，待民政复核）` : '临时安置救助资格校验未通过',
      guards.filter((g) => !g.ok).map((g) => `${g.label}：${g.message}`).join('；') || '全部校验通过',
      u,
    );
    return { application: app, allPass, maxAmount: EMERGENCY_AID_CAP };
  }

  async reviewSubsidy(u: CurrentUser, id: string, body: any) {
    const app = await this.subsidies.findOne({ where: { id } });
    if (!app) throw new NotFoundException();
    // 临时安置救助由民政审批；修缮补助由乡镇住建审批（角色闸先于状态闸）
    if (app.aidKind === AID_KIND_EMERGENCY && u.role !== UserRole.CIVIL_AFFAIRS && u.role !== UserRole.COUNTY_ADMIN) {
      throw new ForbiddenException('临时安置救助由民政部门复核审批');
    }
    if (app.aidKind === AID_KIND_RECTIFY && u.role === UserRole.CIVIL_AFFAIRS) {
      throw new ForbiddenException('修缮补助由乡镇住建复核审批');
    }
    if (app.status !== SubsidyStatus.SUBMITTED) throw new BadRequestException('仅待复核的申请可审批');
    if (app.aidKind === AID_KIND_RECTIFY) {
      const disputes = await this.issues.find({
        where: { houseId: app.houseId, type: IssueType.SUBSIDY_DISPUTE, status: In([IssueStatus.OPEN, IssueStatus.RESOLVING]) },
      });
      if (disputes.length && body.approved) {
        throw new BadRequestException('该户存在未办结的补助资格争议，不得批准补助');
      }
    }
    app.status = body.approved ? SubsidyStatus.APPROVED : SubsidyStatus.REJECTED;
    app.reviewComment = body.comment || (body.approved ? (app.aidKind === AID_KIND_EMERGENCY ? '符合临时救助条件，同意救助' : '资格符合，同意补助') : '复核不通过');
    app.reviewedById = u.sub;
    app.reviewedAt = new Date();
    await this.subsidies.save(app);
    await this.logActivity(
      app.houseId,
      'SUBSIDY',
      app.aidKind === AID_KIND_EMERGENCY
        ? (body.approved ? `临时安置救助已批准 ¥${app.amount}（安置落实后发放）` : '临时安置救助被驳回')
        : (body.approved ? `修缮补助已批准 ¥${app.amount}（复查合格销号后发放）` : '修缮补助被驳回'),
      app.reviewComment,
      u,
    );
    return app;
  }

  async getSubsidyByHouse(houseId: string, aidKind = AID_KIND_RECTIFY) {
    const app = await this.subsidies.findOne({ where: { houseId, aidKind } });
    if (!app) throw new NotFoundException(aidKind === AID_KIND_EMERGENCY ? '该房屋暂无临时安置救助申请' : '该房屋暂无补助申请');
    return app;
  }

  /**
   * 发放闸：
   *  - 修缮补助：必须复查合格、完成销号后发放（防止“带病拨款”）；
   *  - 临时安置救助：民政安置任务已落实（任务办结填写结果）后即可发放，无需等待工程销号。
   */
  async paySubsidy(u: CurrentUser, id: string) {
    const app = await this.subsidies.findOne({ where: { id } });
    if (!app) throw new NotFoundException();
    if (app.status !== SubsidyStatus.APPROVED) throw new BadRequestException('仅已批准的申请可发放');
    if (app.aidKind === AID_KIND_EMERGENCY) {
      if (u.role !== UserRole.CIVIL_AFFAIRS && u.role !== UserRole.COUNTY_ADMIN) {
        throw new ForbiddenException('临时安置救助由民政部门发放');
      }
      // 本户本事件的民政安置任务须已办结（填写安置结果）
      let placementDone = false;
      if (app.taskId) {
        placementDone = !!(await this.rainAssignees.findOne({
          where: { taskId: app.taskId, role: RainTaskType.CIVIL_AFFAIRS, status: RainTaskStatus.DONE },
        }));
      }
      if (!placementDone && app.rainEventId) {
        const civilTask = await this.rainTasks.findOne({ where: { eventId: app.rainEventId, taskType: RainTaskType.CIVIL_AFFAIRS } });
        if (civilTask) {
          placementDone = !!(await this.rainAssignees.findOne({
            where: { taskId: civilTask.id, status: RainTaskStatus.DONE },
          }));
        }
      }
      // 存量方案转移场景（无事件任务）以转移记录兜底
      const evac = app.rainEventId
        ? await this.evacuations.findOne({ where: { rainEventId: app.rainEventId } })
        : await this.evacuations.findOne({ where: { houseId: app.houseId }, order: { settledAt: 'DESC' } });
      if (!placementDone && !evac) {
        throw new BadRequestException('人员临时安置尚未落实（民政安置任务未办结且无转移记录），救助金不得发放');
      }
      app.status = SubsidyStatus.PAID;
      app.paidAt = new Date();
      await this.subsidies.save(app);
      await this.logActivity(app.houseId, 'SUBSIDY', `临时安置救助金已发放 ¥${app.amount}`, '民政应急通道，与修缮补助并行', u);
      return app;
    }
    const close = await this.closes.findOne({ where: { houseId: app.houseId } });
    if (!close) throw new BadRequestException('房屋未复查合格并销号，修缮补助不得提前发放（防止“带病拨款”）');
    app.status = SubsidyStatus.PAID;
    app.paidAt = new Date();
    await this.subsidies.save(app);
    await this.logActivity(app.houseId, 'SUBSIDY', `修缮补助资金已发放 ¥${app.amount}`, '复查合格销号后发放，符合条件家庭', u);
    return app;
  }

  // ---------- 施工过程 ----------
  async addConstructionLog(u: CurrentUser, body: any) {
    const house = await this.getHouseOrFail(body.houseId);
    const cplan = await this.cplans.findOne({ where: { houseId: house.id }, relations: ['budgetItems'] });
    if (!cplan) throw new BadRequestException('尚未提交施工计划');
    if (u.role === 'TEAM' && u.teamId && cplan.teamId !== u.teamId) {
      throw new ForbiddenException('该房屋不是本施工队承接的项目');
    }
    if (house.status === HouseStatus.CLOSED) throw new BadRequestException('房屋已销号');

    // 材料核验：实际材料名称/规格必须能在预算明细中找到，否则判定偷换材料
    let materialVerified = true;
    let swapDetail = '';
    if (body.materialName) {
      const hit = cplan.budgetItems.find(
        (b) => b.name === body.materialName && (!b.spec || !body.materialSpec || b.spec === body.materialSpec),
      );
      materialVerified = !!hit;
      if (!hit) {
        swapDetail = `现场使用「${body.materialName} ${body.materialSpec || ''}」与预算/方案列明材料不一致`;
      }
    }

    return this.dataSource.transaction(async (m) => {
      const log = await m.save(
        m.create(ConstructionLog, {
          houseId: house.id,
          stage: body.stage,
          content: body.content,
          materialName: body.materialName || null,
          materialSpec: body.materialSpec || null,
          photos: body.photos || [],
          progressPercent: Number(body.progressPercent || 0),
          materialVerified,
          recordedAt: new Date(body.recordedAt || Date.now()),
          recorderId: u.sub,
        }),
      );
      // 联动整改项状态
      if (body.itemId) {
        const item = await m.findOne(RectificationItem, { where: { id: body.itemId } });
        if (item) {
          item.status = body.itemStatus || (materialVerified ? ItemStatus.IN_PROGRESS : ItemStatus.PENDING);
          await m.save(item);
        }
      }
      if (!materialVerified) {
        await m.save(
          m.create(IssueRecord, {
            houseId: house.id,
            type: IssueType.MATERIAL_SWAP,
            description: swapDetail,
            status: IssueStatus.OPEN,
            blocksWorkflow: true,
            raisedById: u.sub,
            raisedByName: u.name,
            raisedAt: new Date(),
          }),
        );
      }
      house.status = HouseStatus.RECTIFYING;
      await m.save(house);
      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: materialVerified ? 'CONSTRUCTION' : 'MATERIAL',
          title: materialVerified ? `施工进度上报：${body.stage}（${body.progressPercent || 0}%）` : `材料核验异常：${body.stage}`,
          detail: materialVerified ? body.content : `${swapDetail}；${body.content}`,
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      return log;
    });
  }

  async setItemStatus(u: CurrentUser, itemId: string, status: ItemStatus) {
    const item = await this.items.findOne({ where: { id: itemId } });
    if (!item) throw new NotFoundException();
    item.status = status;
    await this.items.save(item);
    const plan = await this.plans.findOne({ where: { id: item.planId } });
    await this.logActivity(plan.houseId, 'CONSTRUCTION', `整改项「${itemTypeLabel(item.type)}」标记为${itemStatusLabel(status)}`, item.description, u);
    return item;
  }

  // ---------- 验收（逐条确认）----------
  async createAcceptance(u: CurrentUser, body: any) {
    const house = await this.getHouseOrFail(body.houseId);
    const plan = await this.latestPlan(house.id);
    if (!plan) throw new BadRequestException('没有整改方案');
    if (house.status === HouseStatus.CLOSED) throw new BadRequestException('房屋已销号');
    const openRainForAcceptance = await this.rainEvents.findOne({ where: { houseId: house.id, status: In([RainEventStatus.OPEN, RainEventStatus.DISPOSING]) } });
    if (openRainForAcceptance) {
      throw new BadRequestException(`存在未复查合格的雨后风险事件（${openRainForAcceptance.stage}档上报），雨后复查合格前不得组织验收销号`);
    }
    await this.assertNoBlocking(house.id, '组织验收');

    const itemResults: any[] = body.itemResults || [];
    if (plan.items.filter((i) => i.required).length !== itemResults.length) {
      throw new BadRequestException('必须对方案中的每一个必改项逐条给出验收结论');
    }
    // 必改项须先完成施工
    for (const it of plan.items.filter((i) => i.required)) {
      if (it.status !== ItemStatus.DONE) {
        throw new BadRequestException(`整改项「${itemTypeLabel(it.type)}」施工状态为${itemStatusLabel(it.status)}，未完成不能验收`);
      }
      const r = itemResults.find((x) => x.itemId === it.id);
      if (!r) throw new BadRequestException(`缺少整改项「${itemTypeLabel(it.type)}」的验收结论`);
    }
    const anyFail = itemResults.some((r) => r.result === AcceptanceResult.FAIL);
    const overall = anyFail ? AcceptanceResult.FAIL : AcceptanceResult.PASS;

    return this.dataSource.transaction(async (m) => {
      const acc = await m.save(
        m.create(Acceptance, {
          houseId: house.id,
          planId: plan.id,
          inspectorId: u.sub,
          inspectorName: u.name,
          acceptedAt: new Date(),
          overall,
          comment: body.comment || '',
        }),
      );
      for (const r of itemResults) {
        await m.save(
          m.create(AcceptanceItemResult, {
            acceptanceId: acc.id,
            itemId: r.itemId,
            itemType: r.itemType,
            result: r.result,
            note: r.note || '',
            photos: r.photos || [],
          }),
        );
        if (r.result === AcceptanceResult.FAIL) {
          const item = await m.findOne(RectificationItem, { where: { id: r.itemId } });
          if (item) {
            item.status = ItemStatus.FAILED;
            await m.save(item);
          }
        }
      }

      if (overall === AcceptanceResult.FAIL) {
        house.status = HouseStatus.ACCEPTANCE_FAILED;
        await m.save(house);
        await m.save(
          m.create(IssueRecord, {
            houseId: house.id,
            type: IssueType.ACCEPTANCE_FAIL,
            description: `验收不通过：${itemResults.filter((r) => r.result === 'FAIL').map((r) => itemTypeLabel(r.itemType)).join('、')}；${body.comment || ''}`,
            status: IssueStatus.OPEN,
            blocksWorkflow: true,
            raisedById: u.sub,
            raisedByName: u.name,
            raisedAt: new Date(),
          }),
        );
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id,
            kind: 'ACCEPTANCE',
            title: '验收不通过，退回重新整改',
            detail: body.comment || '',
            operatorId: u.sub,
            operatorName: u.name,
          }),
        );
      } else {
        house.status = HouseStatus.PENDING_ACCEPTANCE;
        await m.save(house);
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id,
            kind: 'ACCEPTANCE',
            title: '验收通过（逐项确认合格），提请县级销号',
            detail: body.comment || '',
            operatorId: u.sub,
            operatorName: u.name,
          }),
        );
      }
      return m.findOne(Acceptance, { where: { id: acc.id }, relations: ['itemResults'] });
    });
  }

  // ---------- 销号 ----------
  async closeHouse(u: CurrentUser, body: any) {
    const house = await this.getHouseOrFail(body.houseId);
    // 雨后事件未复查合格，直接阻断销号（先于验收记录检查，避免被其他前置错误掩盖）
    const openRain = await this.rainEvents.findOne({ where: { houseId: house.id, status: In([RainEventStatus.OPEN, RainEventStatus.DISPOSING]) } });
    if (openRain) {
      throw new BadRequestException(`存在未复查合格的雨后风险事件（${openRain.stage}档上报，${openRain.disposition ? rainDispositionLabel(openRain.disposition) : '待处置决定'}），复查合格前不得销号`);
    }
    const acc = await this.acceptances.findOne({ where: { houseId: house.id }, order: { acceptedAt: 'DESC' }, relations: ['itemResults'] });
    if (!acc || acc.overall !== AcceptanceResult.PASS) throw new BadRequestException('最新验收未通过，不能销号');
    if (house.status !== HouseStatus.PENDING_ACCEPTANCE) {
      throw new BadRequestException('仅“验收通过待销号”状态的房屋可销号');
    }
    if (!body.confirmedAllItems) throw new BadRequestException('须逐项确认整改方案全部完成');
    if (!body.confirmedStopUseLifted) throw new BadRequestException('须确认房屋安全恢复、停用/警示措施按方案处理');
    await this.assertNoBlocking(house.id, '销号');

    return this.dataSource.transaction(async (m) => {
      await m.save(
        m.create(CloseRecord, {
          houseId: house.id,
          acceptanceId: acc.id,
          closedAt: new Date(),
          closedById: u.sub,
          confirmedAllItems: true,
          confirmedStopUseLifted: true,
          remark: body.remark || '',
        }),
      );
      house.status = HouseStatus.CLOSED;
      house.stopUseConfirmed = false;
      await m.save(house);
      // 准许转移人员返回
      await m.update(EvacuationRecord, { houseId: house.id, allowReturn: false }, { allowReturn: true, returnedAt: new Date() });
      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: 'CLOSE',
          title: '县级销号：整改按方案完成，房屋恢复安全使用',
          detail: body.remark || '',
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      return { ok: true };
    });
  }

  // ---------- 复查 ----------
  async createRecheck(u: CurrentUser, body: any) {
    const house = await this.getHouseOrFail(body.houseId);
    if (house.status !== HouseStatus.CLOSED) throw new BadRequestException('仅已销号房屋需要复查');
    const result: AcceptanceResult = body.result;
    return this.dataSource.transaction(async (m) => {
      await m.save(
        m.create(RecheckRecord, {
          houseId: house.id,
          result,
          reboundNotes: body.reboundNotes || '',
          wallCrack: body.wallCrack ?? null,
          roofLeak: body.roofLeak ?? null,
          foundationSettlement: body.foundationSettlement ?? null,
          checkedAt: new Date(),
          inspectorId: u.sub,
        }),
      );
      if (result === AcceptanceResult.FAIL) {
        house.status = HouseStatus.REBOUND;
        // 回写最新隐患
        if (body.wallCrack != null) house.wallCrack = Number(body.wallCrack);
        if (body.roofLeak != null) house.roofLeak = Number(body.roofLeak);
        if (body.foundationSettlement != null) house.foundationSettlement = Number(body.foundationSettlement);
        await m.save(house);
        await m.save(
          m.create(IssueRecord, {
            houseId: house.id,
            type: IssueType.REBOUND,
            description: `销号后复查发现问题反弹：${body.reboundNotes || '隐患重新出现'}`,
            status: IssueStatus.OPEN,
            blocksWorkflow: true,
            raisedById: u.sub,
            raisedByName: u.name,
            raisedAt: new Date(),
          }),
        );
      }
      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: 'RECHECK',
          title: result === AcceptanceResult.PASS ? '复查通过，保持销号' : '复查发现问题反弹，重新纳入治理',
          detail: body.reboundNotes || '',
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );
      return { ok: true };
    });
  }

  // ---------- 暴雨后复核：候选筛查 ----------
  /**
   * 从历史裂缝、上次复查结论、整改期限、家庭困难四维筛查真正需要重新上门的房屋。
   * 已纳入开放雨后事件的房屋始终置顶返回（即便房屋已不在整改期状态）。
   */
  async rainCandidates(query: any, u: CurrentUser) {
    const forcedTownship = [UserRole.TOWNSHIP_REVIEWER, UserRole.GRID_WORKER, UserRole.CADRE].includes(u.role as UserRole) ? u.township : null;
    const township = query.township || forcedTownship;
    const where: any = {};
    if (township) where.township = township;
    const houses = await this.houses.find({ where });

    const openEvents = await this.rainEvents.find({
      where: { status: In([RainEventStatus.OPEN, RainEventStatus.DISPOSING]) },
      order: { lastReportAt: 'DESC' },
    });
    const eventMap = new Map(openEvents.map((e) => [e.houseId, e]));

    const rows = [] as any[];
    for (const house of houses) {
      const plan = await this.latestPlan(house.id);
      const family = await this.families.findOne({ where: { houseId: house.id } });
      const lastRecheck = await this.rechecks.findOne({ where: { houseId: house.id }, order: { checkedAt: 'DESC' } });
      const c = scoreRainCandidate(house, plan, family, { lastRecheckResult: lastRecheck?.result });
      const ev = eventMap.get(house.id);
      // 正在整改期（方案已出且未销号），或已有开放事件；已销号房屋不再上门筛查
      const inRectification =
        !!plan && house.status !== HouseStatus.CLOSED;
      if (house.status === HouseStatus.CLOSED && !ev) continue;
      if (!c.needsVisit && !ev) continue;
      rows.push({
        house: {
          id: house.id, code: house.code, township: house.township, village: house.village,
          ownerName: house.ownerName, address: house.address, riskLevel: house.riskLevel,
          status: house.status, wallCrack: house.wallCrack, roofLeak: house.roofLeak,
          foundationSettlement: house.foundationSettlement, residents: house.residents,
          difficult: !!family && family.difficultyType !== DifficultyType.NONE,
          difficultyType: family?.difficultyType || DifficultyType.NONE,
        },
        score: c.score,
        reasons: c.reasons,
        overdue: c.overdue,
        deadlineSoon: c.deadlineSoon,
        deadline: plan?.deadline || null,
        inRectification,
        event: ev ? this.summarizeEvent(ev) : null,
      });
    }
    // 开放事件优先，其次按筛查分值、风险等级排序
    const riskOrder: Record<string, number> = { EVACUATE: 3, SUSPEND: 2, RECTIFY: 1, NORMAL: 0 };
    rows.sort((a, b) => {
      if (!!a.event !== !!b.event) return a.event ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return (riskOrder[b.house.riskLevel] || 0) - (riskOrder[a.house.riskLevel] || 0);
    });
    return { total: rows.length, data: rows };
  }

  private summarizeEvent(e: RainEvent) {
    return {
      id: e.id, status: e.status, riskLevel: e.riskLevel, stage: e.stage, reportCount: e.reportCount,
      disposition: e.disposition, reasons: e.reasons, difficultFamily: e.difficultFamily,
      lastReportAt: e.lastReportAt, extendedDeadline: e.extendedDeadline,
      previousRiskLevel: e.previousRiskLevel,
    };
  }

  // ---------- 暴雨后现场上报：72h 聚合为一条持续升级事件 ----------
  async createRainReport(u: CurrentUser, body: any) {
    const house = await this.getHouseOrFail(body.houseId);
    const measure = {
      wallCrack: Number(body.wallCrack || 0),
      roofLeak: Number(body.roofLeak || 0),
      foundationSettlement: Number(body.foundationSettlement || 0),
      residents: Number(body.residents ?? house.residents ?? 0),
    };
    const { level, reasons } = evaluateRisk({
      buildYear: house.buildYear,
      floors: house.floors,
      isBusiness: house.isBusiness,
      isRented: house.isRented,
      isAddedFloor: house.isAddedFloor,
      wallCrack: measure.wallCrack,
      roofLeak: measure.roofLeak,
      foundationSettlement: measure.foundationSettlement,
      residents: measure.residents,
      rainSeason: true,
    });
    const now = body.reportedAt ? new Date(body.reportedAt) : new Date();
    const family = await this.families.findOne({ where: { houseId: house.id } });

    return this.dataSource.transaction(async (m) => {
      // 找 72h 内最近一条开放/处置中的事件
      const events = await m.find(RainEvent, {
        where: { houseId: house.id },
        order: { lastReportAt: 'DESC' },
        take: 1,
      });
      let event = events[0];
      const withinWindow = event && now.getTime() - new Date(event.lastReportAt).getTime() <= RAIN_MERGE_WINDOW_MS
        && event.status !== RainEventStatus.RESTORED;
      let isNew = false;
      let escalated = false;
      if (!event || !withinWindow) {
        isNew = true;
        const prevPlan = await m.findOne(ReviewPlan, { where: { houseId: house.id }, order: { reviewedAt: 'DESC' } });
        event = m.create(RainEvent, {
          houseId: house.id,
          riskLevel: level,
          stage: 1,
          reportCount: 0,
          status: RainEventStatus.OPEN,
          reasons,
          difficultFamily: !!family && family.difficultyType !== DifficultyType.NONE,
          previousRiskLevel: house.riskLevel,
          previousHouseStatus: house.status,
          previousPlanId: prevPlan?.id || null,
          lastReportAt: now,
        });
      } else {
        const prevReports = await m.find(RainReport, { where: { eventId: event.id }, order: { reportedAt: 'DESC' }, take: 1 });
        const merged = mergeRainReport({
          prevStage: event.stage,
          prevLevel: event.riskLevel,
          prevMeasure: prevReports[0]
            ? {
                wallCrack: prevReports[0].wallCrack, roofLeak: prevReports[0].roofLeak,
                foundationSettlement: prevReports[0].foundationSettlement, residents: prevReports[0].residents,
              }
            : null,
          evaluatedLevel: level,
          measure,
        });
        event.stage = merged.stage;
        event.riskLevel = merged.level;
        event.reasons = reasons;
        escalated = merged.escalated;
        if (family && family.difficultyType !== DifficultyType.NONE) event.difficultFamily = true;
        event.lastReportAt = now;
      }
      event.reportCount += 1;
      event = await m.save(event);

      const report = await m.save(
        m.create(RainReport, {
          eventId: event.id,
          houseId: house.id,
          reporterId: u.sub,
          reporterName: u.name,
          reportedAt: now,
          wallCrack: measure.wallCrack,
          roofLeak: measure.roofLeak,
          foundationSettlement: measure.foundationSettlement,
          residents: measure.residents,
          rainSeason: true,
          riskLevel: level,
          reasons,
          stage: event.stage,
          photos: body.photos || [],
          notes: body.notes || null,
        }),
      );

      // 接回原风险档案：回写最新实测隐患与事件期最高风险等级（不改变治理流程状态）
      house.wallCrack = measure.wallCrack;
      house.roofLeak = measure.roofLeak;
      house.foundationSettlement = measure.foundationSettlement;
      if (measure.residents > 0) house.residents = measure.residents;
      house.ruleReasons = reasons;
      if (rankLevel(event.riskLevel) > rankLevel(house.riskLevel)) house.riskLevel = event.riskLevel;
      await m.save(house);

      await m.save(
        m.create(HouseActivity, {
          houseId: house.id,
          kind: 'RAIN_EVENT',
          title: isNew
            ? `暴雨后复核上报 · ${riskLabel(level)}（风险事件建档）`
            : `暴雨后第 ${event.stage} 次上报并入同一事件${escalated ? `，风险升级为${riskLabel(event.riskLevel)}` : `（${riskLabel(event.riskLevel)}）`}`,
          detail: `裂缝${measure.wallCrack}/渗漏${measure.roofLeak}/沉降${measure.foundationSettlement}；${reasons.join('；')}${body.notes ? `；${body.notes}` : ''}`,
          operatorId: u.sub,
          operatorName: u.name,
        }),
      );

      // 升级到转移级：自动挂“雨季风险加重”非阻断提示（事件本身承载处置，不冻结既有整改进度）
      if (event.riskLevel === RiskLevel.EVACUATE && escalated) {
        await m.save(
          m.create(IssueRecord, {
            houseId: house.id,
            rainEventId: event.id,
            type: IssueType.RAIN_SEASON,
            description: `连续暴雨后险情反复上报并升级至紧急转移级（事件 ${event.stage} 档），需乡镇立即作出处置决定`,
            status: IssueStatus.OPEN,
            blocksWorkflow: false,
            raisedById: u.sub,
            raisedByName: u.name,
            raisedAt: now,
          }),
        );
      }
      return { event: this.summarizeEvent(event), report, merged: !isNew, escalated };
    });
  }

  // ---------- 乡镇处置决定：继续原计划 / 延长整改 / 先转移 ----------
  async decideRainEvent(u: CurrentUser, body: any) {
    const event = await this.rainEvents.findOne({ where: { id: body.eventId } });
    if (!event) throw new NotFoundException('雨后风险事件不存在');
    if (event.status === RainEventStatus.RESTORED) throw new BadRequestException('事件已复查合格关闭，不能再作处置决定');
    const decision: RainDisposition = body.decision;
    if (![RainDisposition.CONTINUE, RainDisposition.EXTEND, RainDisposition.EVACUATE].includes(decision)) {
      throw new BadRequestException('处置决定必须是：继续原计划 / 延长整改 / 先安排人员转移');
    }
    if (decision === RainDisposition.EXTEND && !body.newDeadline) {
      throw new BadRequestException('延长整改必须给出新的整改期限');
    }
    const house = await this.getHouseOrFail(event.houseId);

    return this.dataSource.transaction(async (m) => {
      event.disposition = decision;
      event.dispositionNote = body.note || null;
      event.decidedById = u.sub;
      event.decidedByName = u.name;
      event.decidedAt = new Date();
      event.status = RainEventStatus.DISPOSING;

      const plan = await m.findOne(ReviewPlan, { where: { id: event.previousPlanId || '' }, relations: ['items'] })
        || await m.findOne(ReviewPlan, { where: { houseId: house.id }, order: { reviewedAt: 'DESC' }, relations: ['items'] });

      if (decision === RainDisposition.CONTINUE) {
        // 继续原计划：只叠加风险等级与监测要求，整改项/期限/状态一律不重置
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id, kind: 'RAIN_EVENT',
            title: '雨后处置决定：维持措施，继续按原整改计划推进',
            detail: body.note || '风险可控，原方案、原期限、已完成整改项继续有效，加密雨后监测',
            operatorId: u.sub, operatorName: u.name,
          }),
        );
      } else if (decision === RainDisposition.EXTEND) {
        if (!plan) throw new BadRequestException('该房屋没有在办整改方案，无法延长整改期限');
        const from = plan.deadline;
        if (new Date(`${body.newDeadline}T23:59:59`).getTime() <= new Date(`${from}T23:59:59`).getTime()) {
          throw new BadRequestException('新整改期限必须晚于原期限');
        }
        plan.deadlineHistory = [
          ...(plan.deadlineHistory || []),
          { from, to: body.newDeadline, reason: body.note || '连续暴雨后险情加重，无法按原期限完工', at: new Date().toISOString(), by: u.name },
        ];
        plan.deadline = body.newDeadline;
        event.extendedDeadline = body.newDeadline;
        await m.save(plan);
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id, kind: 'RAIN_EVENT',
            title: `雨后处置决定：延长整改期限至 ${body.newDeadline}（原期限 ${from}）`,
            detail: body.note || '', operatorId: u.sub, operatorName: u.name,
          }),
        );
      } else {
        // 先安排人员转移：升级风险等级、方案加挂转移要求，但不重置整改状态与整改项
        event.riskLevel = RiskLevel.EVACUATE;
        house.riskLevel = maxLevel(house.riskLevel, RiskLevel.EVACUATE);
        if (plan) {
          plan.evacuationRequired = true;
          if (rankLevel(plan.decision) < rankLevel(RiskLevel.SUSPEND)) plan.stopUseRequired = true;
          await m.save(plan);
        }
        await m.save(house);
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id, kind: 'RAIN_EVENT',
            title: '雨后处置决定：先安排人员转移，村干部/住建/民政收到同一处置任务',
            detail: body.note || '在原整改计划基础上加挂人员转移与临时管控，转移未落实前不得复工',
            operatorId: u.sub, operatorName: u.name,
          }),
        );
        await this.createDispositionTasks(m, event, house, u);
      }

      await m.save(event);
      return { event: this.summarizeEvent(event) };
    });
  }

  /** 转移级处置：村干部、住建、民政收到同一条处置任务（同一 eventId 串联） */
  private async createDispositionTasks(m: EntityManager, event: RainEvent, house: House, u: CurrentUser) {
    const cadre = await m.findOne(User, { where: { role: UserRole.CADRE, township: house.township } });
    const town = await m.findOne(User, { where: { role: UserRole.TOWNSHIP_REVIEWER, township: house.township } });
    const civil = await m.findOne(User, { where: { role: UserRole.CIVIL_AFFAIRS } });
    const defs: { type: RainTaskType; title: string; requirement: string; user: User | null }[] = [
      {
        type: RainTaskType.CADRE_URGENT,
        title: `紧急转移管控：${house.code} ${house.ownerName}户`,
        requirement: '立即组织屋内人员撤离至安全安置点，设置警戒和危房警示，落实临时管控并反馈转移人数',
        user: cadre,
      },
      {
        type: RainTaskType.TOWNSHIP_DISPOSE,
        title: `住建处置：${house.code} 雨后停用与工程整改`,
        requirement: '确认暂停使用/封停，在原整改方案基础上评估加固措施，转移人员复查合格前不得准许返回',
        user: town,
      },
      {
        type: RainTaskType.CIVIL_AFFAIRS,
        title: `民政救助：${house.code} ${house.ownerName}户临时安置`,
        requirement: event.difficultFamily
          ? '困难家庭：落实临时安置点/生活救助，同步受理临时安置救助与修缮补助申请'
          : '落实临时安置点与基本生活保障；如经核查符合救助条件，协助申请临时救助',
        user: civil,
      },
    ];
    const tasks = [];
    for (const d of defs) {
      const task = await m.save(
        m.create(DispositionTask, {
          eventId: event.id, houseId: house.id, taskType: d.type,
          title: d.title, requirement: d.requirement, createdAt: new Date(),
        }),
      );
      await m.save(
        m.create(DispositionAssignee, {
          taskId: task.id, role: d.type,
          userId: d.user?.id || null, userName: d.user?.name || null,
        }),
      );
      tasks.push(task);
    }
    await m.save(
      m.create(HouseActivity, {
        houseId: house.id, kind: 'RAIN_EVENT',
        title: `同一处置任务已下达三方（村干部 / 住建 / 民政），共 ${tasks.length} 项`,
        detail: '三方任务按同一风险事件联动；困难家庭可同时申请临时安置救助与修缮补助',
        operatorId: u.sub, operatorName: u.name,
      }),
    );
  }

  /** 三方任务认领/办结（办结必须填写处置结果） */
  async completeRainTask(u: CurrentUser, body: any) {
    const task = await this.rainTasks.findOne({ where: { id: body.taskId }, relations: ['assignees'] });
    if (!task) throw new NotFoundException('处置任务不存在');
    if (!body.result) throw new BadRequestException('办结处置任务必须填写处置结果');
    // 三方任务各归其责：村干部/住建/民政只能办结本部门任务；县级可督办办结任一任务
    const roleOwned: Record<string, RainTaskType> = {
      [UserRole.CADRE]: RainTaskType.CADRE_URGENT,
      [UserRole.CIVIL_AFFAIRS]: RainTaskType.CIVIL_AFFAIRS,
      [UserRole.TOWNSHIP_REVIEWER]: RainTaskType.TOWNSHIP_DISPOSE,
    };
    if (roleOwned[u.role] && roleOwned[u.role] !== task.taskType) {
      throw new ForbiddenException(`该任务责任方为${rainTaskTypeLabel(task.taskType)}，不能由${rainTaskTypeLabel(roleOwned[u.role])}办结`);
    }
    return this.dataSource.transaction(async (m) => {
      task.status = RainTaskStatus.DONE;
      task.doneAt = new Date();
      task.result = body.result;
      // 把责任方落实到实际办理人（未预分配账号时即“领取并办结”）
      let assignee = task.assignees.find((a) => a.role === this.roleToTaskType(u.role))
        || task.assignees[0];
      if (!assignee) {
        assignee = await m.save(m.create(DispositionAssignee, {
          taskId: task.id, role: this.roleToTaskType(u.role), userId: u.sub, userName: u.name,
        }));
        task.assignees.push(assignee);
      }
      assignee.status = RainTaskStatus.DONE;
      assignee.doneAt = new Date();
      assignee.result = body.result;
      if (!assignee.userId) {
        assignee.userId = u.sub;
        assignee.userName = u.name;
      }
      await m.save(assignee);
      await m.save(task);

      const event = await m.findOne(RainEvent, { where: { id: task.eventId } });
      const house = await m.findOne(House, { where: { id: task.houseId } });
      await m.save(
        m.create(HouseActivity, {
          houseId: task.houseId, kind: 'RAIN_EVENT',
          title: `处置任务办结（${rainTaskTypeLabel(task.taskType)}）：${task.title}`,
          detail: body.result, operatorId: u.sub, operatorName: u.name,
        }),
      );
      // 村干部转移任务办结：若已有转移登记则确认管控；民政任务办结不触发工程状态变化
      void event;
      void house;
      return { ok: true, task };
    });
  }

  private roleToTaskType(role: string): RainTaskType {
    if (role === UserRole.CADRE) return RainTaskType.CADRE_URGENT;
    if (role === UserRole.CIVIL_AFFAIRS) return RainTaskType.CIVIL_AFFAIRS;
    return RainTaskType.TOWNSHIP_DISPOSE;
  }

  /** 雨后复查：合格 → 恢复原风险等级/治理状态并允许销号；不合格 → 阻断事件、阻断销号 */
  async createRainRecheck(u: CurrentUser, body: any) {
    const event = await this.rainEvents.findOne({ where: { id: body.eventId } });
    if (!event) throw new NotFoundException('雨后风险事件不存在');
    if (event.status === RainEventStatus.RESTORED) throw new BadRequestException('该事件已复查合格关闭');
    if (event.status !== RainEventStatus.DISPOSING) throw new BadRequestException('须先由乡镇作出处置决定后再复查');
    const house = await this.getHouseOrFail(event.houseId);
    const pass = body.result === AcceptanceResult.PASS;
    // 转移级事件复查合格前，人员不得返回（与既有转移记录联动）
    if (pass && event.disposition === RainDisposition.EVACUATE) {
      const pendingTasks = await this.rainTasks.count({
        where: { eventId: event.id, status: RainTaskStatus.PENDING },
      });
      if (pendingTasks > 0 && !body.ignoreTasks) {
        throw new BadRequestException(`仍有 ${pendingTasks} 项村干部/住建/民政处置任务未办结，复查合格前须落实完毕`);
      }
    }

    return this.dataSource.transaction(async (m) => {
      await m.save(
        m.create(RecheckRecord, {
          houseId: house.id, result: pass ? AcceptanceResult.PASS : AcceptanceResult.FAIL,
          reboundNotes: `雨后复查（事件 ${event.stage} 档）：${body.notes || ''}`,
          wallCrack: body.wallCrack ?? null, roofLeak: body.roofLeak ?? null,
          foundationSettlement: body.foundationSettlement ?? null,
          checkedAt: new Date(), inspectorId: u.sub,
        }),
      );

      if (!pass) {
        // 复查不合格：事件保持处置中并开阻断单（阻断验收/销号），必须重新处置后再复查
        await m.save(
          m.create(IssueRecord, {
            houseId: house.id, rainEventId: event.id,
            type: IssueType.RAIN_RECHECK_FAIL,
            description: `雨后复查不合格：${body.notes || '险情仍未消除'}`,
            status: IssueStatus.OPEN, blocksWorkflow: true,
            raisedById: u.sub, raisedByName: u.name, raisedAt: new Date(),
          }),
        );
        await m.save(
          m.create(HouseActivity, {
            houseId: house.id, kind: 'RAIN_EVENT',
            title: '雨后复查不合格，事件继续处置（验收/销号冻结）',
            detail: body.notes || '', operatorId: u.sub, operatorName: u.name,
          }),
        );
        return { ok: true, restored: false };
      }

      // 复查合格：恢复事件前风险等级与治理状态（延长/转移决定带来的措施按复查结论解除）
      event.status = RainEventStatus.RESTORED;
      event.restoredAt = new Date();
      event.restoreNote = body.notes || '雨后复查合格，恢复正常等级';
      if (event.previousRiskLevel) house.riskLevel = event.previousRiskLevel;
      if (event.previousHouseStatus) {
        // 事件期间若房屋本身已沿流程推进（如已到待销号），不回退；仅恢复被事件打断/抬高的状态
        const advanced = [HouseStatus.PENDING_ACCEPTANCE, HouseStatus.CLOSED].includes(house.status);
        if (!advanced) house.status = event.previousHouseStatus;
      }
      // 解除因事件加挂的停用/转移要求，恢复为复核决定本身对应的措施
      const plan = event.previousPlanId
        ? await m.findOne(ReviewPlan, { where: { id: event.previousPlanId } })
        : null;
      if (plan) {
        plan.evacuationRequired = plan.decision === RiskLevel.EVACUATE;
        plan.stopUseRequired = plan.decision === RiskLevel.SUSPEND || plan.decision === RiskLevel.EVACUATE;
        await m.save(plan);
        if (!plan.stopUseRequired) house.stopUseConfirmed = false;
      } else {
        house.stopUseConfirmed = false;
      }
      await m.save(house);
      // 准许本次事件转移人员返回
      await m.update(EvacuationRecord, { rainEventId: event.id, allowReturn: false }, { allowReturn: true, returnedAt: new Date() });
      // 复查合格：自动办结事件相关全部提示与阻断单（含历次雨后复查不合格单），解除验收/销号冻结
      await m.update(IssueRecord, { rainEventId: event.id, status: In([IssueStatus.OPEN, IssueStatus.RESOLVING]) }, { status: IssueStatus.RESOLVED, resolvedAt: new Date(), resolution: '雨后复查合格，系统自动办结' });
      await m.save(event);
      await m.save(
        m.create(HouseActivity, {
          houseId: house.id, kind: 'RAIN_EVENT',
          title: `雨后复查合格，风险等级恢复为${riskLabel(house.riskLevel)}，事件关闭`,
          detail: body.notes || '房屋恢复正常等级，可继续验收销号流程',
          operatorId: u.sub, operatorName: u.name,
        }),
      );
      return { ok: true, restored: true, riskLevel: house.riskLevel, houseStatus: house.status };
    });
  }

  // ---------- 雨后事件/任务查询 ----------
  async listRainEvents(query: any, u: CurrentUser) {
    const qb = this.rainEvents.createQueryBuilder('e')
      .leftJoin(House, 'h', 'h.id::text = e."houseId"');
    if (query.status) qb.andWhere('e.status = :s', { s: query.status });
    if (query.disposition) qb.andWhere('e.disposition = :d', { d: query.disposition });
    const township = query.township || ([UserRole.TOWNSHIP_REVIEWER, UserRole.GRID_WORKER, UserRole.CADRE].includes(u.role as UserRole) ? u.township : undefined);
    if (township) qb.andWhere('h.township = :t', { t: township });
    qb.orderBy('e."lastReportAt"', 'DESC').limit(300);
    const events = await qb.getMany();
    const houseIds = [...new Set(events.map((e) => e.houseId))];
    const houses = await this.houses.find({ where: { id: In(houseIds) } });
    const hmap = new Map(houses.map((h) => [h.id, h]));
    return events.map((e) => ({ ...this.summarizeEvent(e), house: hmap.get(e.houseId) ? {
      id: e.houseId, code: hmap.get(e.houseId)!.code, township: hmap.get(e.houseId)!.township,
      village: hmap.get(e.houseId)!.village, ownerName: hmap.get(e.houseId)!.ownerName,
      status: hmap.get(e.houseId)!.status,
    } : null }));
  }

  async rainEventDetail(eventId: string) {
    const event = await this.rainEvents.findOne({ where: { id: eventId } });
    if (!event) throw new NotFoundException('雨后风险事件不存在');
    const [reports, tasks] = await Promise.all([
      this.rainReports.find({ where: { eventId }, order: { reportedAt: 'ASC' } }),
      this.rainTasks.find({ where: { eventId }, relations: ['assignees'] }),
    ]);
    return { event, reports, tasks };
  }

  async myRainTasks(u: CurrentUser) {
    const type = this.roleToTaskType(u.role);
    const qb = this.rainAssignees.createQueryBuilder('a')
      .leftJoin(DispositionTask, 't', 't.id = a."taskId"')
      .leftJoin(House, 'h', 'h.id::text = t."houseId"');
    // 乡镇住建人员只看本乡镇；县级/民政看全部；村干部按账号乡镇
    if (u.role === UserRole.TOWNSHIP_REVIEWER || u.role === UserRole.GRID_WORKER || u.role === UserRole.CADRE) {
      qb.andWhere('h.township = :t', { t: u.township || '' });
    }
    if (u.role === UserRole.CADRE) qb.andWhere('a.role = :r', { r: RainTaskType.CADRE_URGENT });
    if (u.role === UserRole.CIVIL_AFFAIRS) qb.andWhere('a.role = :r', { r: RainTaskType.CIVIL_AFFAIRS });
    if (u.role === UserRole.TOWNSHIP_REVIEWER) qb.andWhere('a.role = :r', { r: RainTaskType.TOWNSHIP_DISPOSE });
    void type;
    qb.orderBy('t."createdAt"', 'DESC').limit(200);
    const assignees = await qb.getMany();
    const taskIds = [...new Set(assignees.map((a) => a.taskId))];
    const tasks = await this.rainTasks.find({ where: { id: In(taskIds) }, relations: ['assignees'] });
    const houseIds = [...new Set(tasks.map((t) => t.houseId))];
    const houses = await this.houses.find({ where: { id: In(houseIds) } });
    const hmap = new Map(houses.map((h) => [h.id, h]));
    return tasks.map((t) => ({
      id: t.id, eventId: t.eventId, houseId: t.houseId, taskType: t.taskType,
      title: t.title, requirement: t.requirement, status: t.status,
      doneAt: t.doneAt, result: t.result, assignees: t.assignees,
      house: hmap.get(t.houseId) ? { code: hmap.get(t.houseId)!.code, ownerName: hmap.get(t.houseId)!.ownerName, village: hmap.get(t.houseId)!.village } : null,
    }));
  }

  // ---------- 房屋档案聚合 ----------
  async listHouses(query: any, u: CurrentUser) {
    const qb = this.houses.createQueryBuilder('h');
    const township = query.township || (u.role === 'TOWNSHIP_REVIEWER' || u.role === 'GRID_WORKER' ? u.township : undefined);
    if (township) qb.andWhere('h.township = :t', { t: township });
    if (query.riskLevel) qb.andWhere('h.riskLevel = :r', { r: query.riskLevel });
    if (query.status) qb.andWhere('h.status = :s', { s: query.status });
    if (query.q) qb.andWhere('(h.ownerName ILIKE :q OR h.address ILIKE :q OR h.code ILIKE :q OR h.village ILIKE :q)', { q: `%${query.q}%` });
    qb.orderBy('h.createdAt', 'DESC');
    const [data, total] = await qb.take(Math.min(Number(query.limit) || 100, 500)).skip(Number(query.offset) || 0).getManyAndCount();
    return { total, data };
  }

  async houseArchive(id: string) {
    const house = await this.getHouseOrFail(id);
    const [
      inspections, plans, notices, evacuations, stakeholders, consultations, issues,
      family, cplan, subsidyList, logs, acceptances, close, rechecks, activities,
      rainEvents, rainTasks,
    ] = await Promise.all([
      this.inspections.find({ where: { houseId: id }, order: { inspectedAt: 'DESC' } }),
      this.plans.find({ where: { houseId: id }, order: { reviewedAt: 'DESC' }, relations: ['items'] }),
      this.notices.find({ where: { houseId: id }, order: { notifiedAt: 'DESC' } }),
      this.evacuations.find({ where: { houseId: id }, order: { settledAt: 'DESC' } }),
      this.stakeholders.find({ where: { houseId: id } }),
      this.consultations.find({ where: { houseId: id }, order: { heldAt: 'DESC' } }),
      this.issues.find({ where: { houseId: id }, order: { raisedAt: 'DESC' } }),
      this.families.findOne({ where: { houseId: id } }),
      this.cplans.findOne({ where: { houseId: id }, relations: ['budgetItems'] }),
      this.subsidies.find({ where: { houseId: id }, order: { createdAt: 'DESC' } }),
      this.logs.find({ where: { houseId: id }, order: { recordedAt: 'DESC' } }),
      this.acceptances.find({ where: { houseId: id }, order: { acceptedAt: 'DESC' }, relations: ['itemResults'] }),
      this.closes.findOne({ where: { houseId: id } }),
      this.rechecks.find({ where: { houseId: id }, order: { checkedAt: 'DESC' } }),
      this.activities.find({ where: { houseId: id }, order: { createdAt: 'DESC' }, take: 200 }),
      this.rainEvents.find({ where: { houseId: id }, order: { lastReportAt: 'DESC' } }),
      this.rainTasks.find({ where: { houseId: id }, relations: ['assignees'], order: { createdAt: 'DESC' } }),
    ]);
    const blockingIssues = issues.filter((i) => i.blocksWorkflow && i.status !== IssueStatus.RESOLVED);
    const subsidy = subsidyList.find((s) => s.aidKind !== AID_KIND_EMERGENCY) || subsidyList[0] || null;
    const emergencyAid = subsidyList.find((s) => s.aidKind === AID_KIND_EMERGENCY) || null;
    const rainEventIds = new Set(rainEvents.map((e) => e.id));
    const rainReports = rainEvents.length
      ? await this.rainReports.find({ where: { eventId: In([...rainEventIds]) }, order: { reportedAt: 'DESC' } })
      : [];
    return {
      house, inspections, plans, notices, evacuations, stakeholders, consultations, issues, blockingIssues,
      family, constructionPlan: cplan, subsidy, subsidies: subsidyList, emergencyAid,
      constructionLogs: logs, acceptances, close, rechecks, activities,
      rainEvents, rainReports, rainTasks,
    };
  }

  // ---------- 县级驾驶舱 ----------
  async dashboard(query: any, u?: CurrentUser) {
    const forcedTownship = u && (u.role === 'TOWNSHIP_REVIEWER' || u.role === 'GRID_WORKER') ? u.township : null;
    const township = query.township || forcedTownship || null;
    const filter = township ? { township } : {};
    const houses = await this.houses.find({ where: filter });
    const byRisk: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    const byTownship: Record<string, { total: number; highRisk: number; closed: number; rebound: number }> = {};
    let closed = 0, rebound = 0, highRisk = 0, highRiskStopped = 0;
    for (const h of houses) {
      byRisk[h.riskLevel] = (byRisk[h.riskLevel] || 0) + 1;
      byStatus[h.status] = (byStatus[h.status] || 0) + 1;
      const t = byTownship[h.township] || { total: 0, highRisk: 0, closed: 0, rebound: 0 };
      t.total++;
      const isHigh = h.riskLevel === RiskLevel.SUSPEND || h.riskLevel === RiskLevel.EVACUATE;
      if (isHigh) {
        highRisk++;
        t.highRisk++;
        if ([HouseStatus.STOPPED, HouseStatus.EVACUATED, HouseStatus.RECTIFYING, HouseStatus.PENDING_ACCEPTANCE, HouseStatus.CLOSED, HouseStatus.ACCEPTANCE_FAILED].includes(h.status)) {
          highRiskStopped++;
        }
      }
      if (h.status === HouseStatus.CLOSED) {
        closed++;
        t.closed++;
      }
      if (h.status === HouseStatus.REBOUND) {
        rebound++;
        t.rebound++;
      }
      byTownship[h.township] = t;
    }

    // 高风险但未真正停用的房屋（县级最关注）
    const qbStopped = this.houses
      .createQueryBuilder('h')
      .where('h.riskLevel IN (:...rs)', { rs: [RiskLevel.SUSPEND, RiskLevel.EVACUATE] })
      .andWhere('h.status NOT IN (:...ss)', {
        ss: [HouseStatus.STOPPED, HouseStatus.EVACUATED, HouseStatus.RECTIFYING, HouseStatus.PENDING_ACCEPTANCE, HouseStatus.CLOSED, HouseStatus.ACCEPTANCE_FAILED],
      });
    if (township) qbStopped.andWhere('h.township = :t', { t: township });
    const notStopped = await qbStopped.getMany();

    // 异常分类
    const issueQb = this.issues.createQueryBuilder('i').leftJoin(House, 'h', 'h.id::text = i."houseId"::text');
    if (township) issueQb.andWhere('h.township = :t', { t: township });
    const allIssues = await issueQb.getMany();
    const issuesByType: Record<string, { open: number; resolved: number }> = {};
    for (const i of allIssues) {
      const k = i.type;
      issuesByType[k] = issuesByType[k] || { open: 0, resolved: 0 };
      if (i.status === IssueStatus.RESOLVED) issuesByType[k].resolved++;
      else issuesByType[k].open++;
    }

    // 补助（区分修缮补助与临时安置救助双通道）
    const subQb = this.subsidies.createQueryBuilder('s').leftJoin(House, 'h', 'h.id::text = s."houseId"::text');
    if (township) subQb.andWhere('h.township = :t', { t: township });
    const subsidies = await subQb.getMany();
    const subsidySummary = { draft: 0, submitted: 0, approved: 0, rejected: 0, paid: 0, paidAmount: 0 };
    const emergencySummary = { draft: 0, submitted: 0, approved: 0, rejected: 0, paid: 0, paidAmount: 0 };
    for (const s of subsidies) {
      const target = s.aidKind === AID_KIND_EMERGENCY ? emergencySummary : subsidySummary;
      if (s.status === SubsidyStatus.DRAFT) target.draft++;
      if (s.status === SubsidyStatus.SUBMITTED) target.submitted++;
      if (s.status === SubsidyStatus.APPROVED) target.approved++;
      if (s.status === SubsidyStatus.REJECTED) target.rejected++;
      if (s.status === SubsidyStatus.PAID) {
        target.paid++;
        target.paidAmount += Number(s.amount);
      }
    }

    // 暴雨后风险事件与同一处置任务
    const rainQb = this.rainEvents.createQueryBuilder('e').leftJoin(House, 'h', 'h.id::text = e."houseId"');
    if (township) rainQb.andWhere('h.township = :t', { t: township });
    const rainAll = await rainQb.getMany();
    const rainSummary = { total: rainAll.length, open: 0, disposing: 0, restored: 0, evacuate: 0, difficult: 0, repeated: 0 };
    for (const e of rainAll) {
      if (e.status === RainEventStatus.OPEN) rainSummary.open++;
      if (e.status === RainEventStatus.DISPOSING) rainSummary.disposing++;
      if (e.status === RainEventStatus.RESTORED) rainSummary.restored++;
      if (e.disposition === RainDisposition.EVACUATE) rainSummary.evacuate++;
      if (e.difficultFamily) rainSummary.difficult++;
      if (e.reportCount > 1) rainSummary.repeated++;
    }
    const taskQb = this.rainAssignees.createQueryBuilder('a')
      .leftJoin(DispositionTask, 't', 't.id = a."taskId"')
      .leftJoin(House, 'h', 'h.id::text = t."houseId"');
    if (township) taskQb.andWhere('h.township = :t', { t: township });
    const allAssignees = await taskQb.getMany();
    const rainTaskSummary: Record<string, { total: number; done: number }> = {};
    for (const a of allAssignees) {
      const k = rainTaskTypeLabel(a.role);
      rainTaskSummary[a.role] = rainTaskSummary[a.role] || { total: 0, done: 0 };
      rainTaskSummary[a.role].total++;
      if (a.status === RainTaskStatus.DONE) rainTaskSummary[a.role].done++;
      void k;
    }

    // 整改项完成情况
    const planQb = this.items.createQueryBuilder('it').leftJoin(ReviewPlan, 'p', 'p.id::text = it."planId"::text').leftJoin(House, 'h', 'h.id::text = p."houseId"::text');
    if (township) planQb.andWhere('h.township = :t', { t: township });
    const allItems = await planQb.getMany();
    const itemByType: Record<string, { total: number; done: number; failed: number }> = {};
    for (const it of allItems) {
      const k = itemByType[it.type] || { total: 0, done: 0, failed: 0 };
      k.total++;
      if (it.status === ItemStatus.DONE) k.done++;
      if (it.status === ItemStatus.FAILED) k.failed++;
      itemByType[it.type] = k;
    }

    return {
      totalHouses: houses.length,
      byRisk,
      byStatus,
      byTownship,
      closed,
      rebound,
      highRisk,
      highRiskStopped,
      highRiskStopRate: highRisk ? Number((highRiskStopped / highRisk).toFixed(2)) : 1,
      notStoppedHouses: notStopped.map((h) => ({ id: h.id, code: h.code, township: h.township, village: h.village, ownerName: h.ownerName, riskLevel: h.riskLevel, status: h.status })),
      issuesByType,
      subsidySummary,
      emergencySummary,
      rainSummary,
      rainTaskByRole: Object.entries(rainTaskSummary).map(([role, v]) => ({ role, label: rainTaskTypeLabel(role), ...v })),
      itemByType,
      closureRate: houses.length ? Number((closed / houses.length).toFixed(2)) : 0,
    };
  }
}

// ---------- 标签 ----------
export function riskLabel(l: RiskLevel) {
  return { NORMAL: '一般关注', RECTIFY: '限期整改', SUSPEND: '暂停使用', EVACUATE: '紧急转移' }[l] || l;
}
export function houseStatusLabel(s: HouseStatus) {
  return {
    PENDING_REVIEW: '待复核', IN_PLAN: '已出方案', NOTIFIED: '已告知', STOPPED: '已停用',
    EVACUATED: '已转移', RECTIFYING: '整改中', PENDING_ACCEPTANCE: '待销号', ACCEPTANCE_FAILED: '验收不通过',
    CLOSED: '已销号', REBOUND: '问题反弹', REFUSED: '拒绝整改',
  }[s] || s;
}
export function itemTypeLabel(t: string) {
  return {
    REMOVE_ILLEGAL_FLOOR: '拆除违建加层', REINFORCE_WALL: '加固承重墙', REPAIR_ROOF: '修复屋面',
    EVICT_TENANTS: '清退经营租户', SET_WARNING: '设置警示', TEMP_RESETTLEMENT: '安排临时安置',
  }[t] || t;
}
export function itemStatusLabel(s: string) {
  return { PENDING: '待施工', IN_PROGRESS: '施工中', DONE: '已完成', FAILED: '不合格' }[s] || s;
}
export function issueTypeLabel(t: string) {
  return {
    FARMER_REFUSE: '农户拒绝整改', MATERIAL_SWAP: '偷换材料', SUBSIDY_DISPUTE: '补助资格争议',
    RAIN_SEASON: '雨季风险加重', TENANT_REFUSE: '租户不愿搬离', ACCEPTANCE_FAIL: '验收不通过', REBOUND: '问题反弹',
    RAIN_RECHECK_FAIL: '雨后复查不合格',
  }[t] || t;
}
export function rainDispositionLabel(d: string) {
  return { CONTINUE: '继续原整改计划', EXTEND: '延长整改期限', EVACUATE: '先安排人员转移' }[d] || d;
}
export function rainEventStatusLabel(s: string) {
  return { OPEN: '待处置决定', DISPOSING: '处置中·待复查', RESTORED: '复查合格已关闭' }[s] || s;
}
export function rainTaskTypeLabel(t: string) {
  return { CADRE_URGENT: '村干部', TOWNSHIP_DISPOSE: '住建', CIVIL_AFFAIRS: '民政' }[t] || t;
}
export function difficultyLabel(d: string) {
  return {
    NONE: '无', LOW_INCOME: '低保户', FIVE_GUARANTEE: '五保户', DISABLED: '残疾人家庭',
    MONITORING: '防止返贫监测户', VETERAN: '优抚对象',
  }[d] || d;
}
