import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import {
  Acceptance,
  AcceptanceItemResult,
  BudgetItem,
  CloseRecord,
  ConstructionLog,
  ConstructionPlan,
  ConstructionTeam,
  Consultation,
  DispositionAssignee,
  DispositionTask,
  EvacuationRecord,
  FamilyProfile,
  House,
  HouseActivity,
  Inspection,
  IssueRecord,
  NoticeRecord,
  RainEvent,
  RainReport,
  RectificationItem,
  RecheckRecord,
  ReviewPlan,
  Stakeholder,
  SubsidyApplication,
  User,
} from './entities';
import { AppService } from './app.service';
import { AppController } from './app.controller';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { SeedService } from './seed.service';

const entities = [
  User, House, Inspection, ReviewPlan, RectificationItem, NoticeRecord, EvacuationRecord,
  Stakeholder, Consultation, IssueRecord, FamilyProfile, ConstructionTeam, ConstructionPlan,
  BudgetItem, SubsidyApplication, ConstructionLog, Acceptance, AcceptanceItemResult,
  CloseRecord, RecheckRecord, HouseActivity, RainEvent, RainReport, DispositionTask, DispositionAssignee,
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
  controllers: [AuthController, AppController],
  providers: [
    AppService,
    SeedService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
