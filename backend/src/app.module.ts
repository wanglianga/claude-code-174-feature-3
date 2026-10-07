import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  Acceptance,
  AcceptanceItemResult,
  BudgetItem,
  CloseRecord,
  ConstructionLog,
  ConstructionPlan,
  ConstructionTeam,
  Consultation,
  DispatchTask,
  EvacuationRecord,
  FamilyProfile,
  House,
  HouseActivity,
  Inspection,
  IssueRecord,
  NoticeRecord,
  RainReport,
  RectificationExtension,
  RectificationItem,
  RecheckRecord,
  ReviewPlan,
  RiskEvent,
  Stakeholder,
  SubsidyApplication,
  User,
} from './entities';
import { AppService } from './app.service';
import { AppController } from './app.controller';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { SeedService } from './seed.service';
import { RainService } from './rain.service';
import { RainController } from './rain.controller';

const entities = [
  User, House, Inspection, ReviewPlan, RectificationItem, NoticeRecord, EvacuationRecord,
  Stakeholder, Consultation, IssueRecord, FamilyProfile, ConstructionTeam, ConstructionPlan,
  BudgetItem, SubsidyApplication, ConstructionLog, Acceptance, AcceptanceItemResult,
  CloseRecord, RecheckRecord, HouseActivity,
  RainReport, RiskEvent, DispatchTask, RectificationExtension,
];

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      database: process.env.DB_NAME || 'rural_house',
      entities,
      synchronize: true,
    }),
    TypeOrmModule.forFeature(entities),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET || 'rural-house-safety-dev-secret',
      signOptions: { expiresIn: '12h' },
    }),
  ],
  controllers: [AuthController, AppController, RainController],
  providers: [
    AppService,
    RainService,
    SeedService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
