// Lazy route components, one chunk per page; ChunkLoadError handling lives in ErrorBoundary.
import { lazy } from 'react';

export const LoginPage = lazy(() =>
  import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })),
);
export const SignupPage = lazy(() =>
  import('./pages/SignupPage').then((m) => ({ default: m.SignupPage })),
);
export const VerifyEmailPage = lazy(() =>
  import('./pages/VerifyEmailPage').then((m) => ({ default: m.VerifyEmailPage })),
);
export const ApproveSignupPage = lazy(() =>
  import('./pages/ApproveSignupPage').then((m) => ({ default: m.ApproveSignupPage })),
);
export const RequestPasswordResetPage = lazy(() =>
  import('./pages/RequestPasswordResetPage').then((m) => ({
    default: m.RequestPasswordResetPage,
  })),
);
export const ResetPasswordPage = lazy(() =>
  import('./pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })),
);
export const FactorUndoPage = lazy(() =>
  import('./pages/FactorUndoPage').then((m) => ({ default: m.FactorUndoPage })),
);
export const DeclineSignupPage = lazy(() =>
  import('./pages/DeclineSignupPage').then((m) => ({ default: m.DeclineSignupPage })),
);
export const ChangeEmailConfirmPage = lazy(() =>
  import('./pages/ChangeEmailConfirmPage').then((m) => ({
    default: m.ChangeEmailConfirmPage,
  })),
);
export const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })),
);
export const PreferencesPage = lazy(() =>
  import('./pages/PreferencesPage').then((m) => ({ default: m.PreferencesPage })),
);
export const SecurityPage = lazy(() =>
  import('./pages/SecurityPage').then((m) => ({ default: m.SecurityPage })),
);
export const WorkspacePage = lazy(() =>
  import('./pages/WorkspacePage').then((m) => ({ default: m.WorkspacePage })),
);
export const HouseholdPage = lazy(() =>
  import('./pages/HouseholdPage').then((m) => ({ default: m.HouseholdPage })),
);
export const AccountsPage = lazy(() =>
  import('./pages/AccountsPage').then((m) => ({ default: m.AccountsPage })),
);
export const AccountBalancesPage = lazy(() =>
  import('./pages/AccountBalancesPage').then((m) => ({ default: m.AccountBalancesPage })),
);
export const AccountBalancesListPage = lazy(() =>
  import('./pages/AccountBalancesListPage').then((m) => ({ default: m.AccountBalancesListPage })),
);
export const AccountContributionsPage = lazy(() =>
  import('./pages/AccountContributionsPage').then((m) => ({ default: m.AccountContributionsPage })),
);
export const SocialSecurityPage = lazy(() =>
  import('./pages/SocialSecurityPage').then((m) => ({ default: m.SocialSecurityPage })),
);
export const ScenariosPage = lazy(() =>
  import('./pages/ScenariosPage').then((m) => ({ default: m.ScenariosPage })),
);
export const ScenarioDetailPage = lazy(() =>
  import('./pages/ScenarioDetailPage').then((m) => ({ default: m.ScenarioDetailPage })),
);
export const ScenarioExpenseOverridesPage = lazy(() =>
  import('./pages/ScenarioExpenseOverridesPage').then((m) => ({
    default: m.ScenarioExpenseOverridesPage,
  })),
);
export const ScenarioIncomeOverridesPage = lazy(() =>
  import('./pages/ScenarioIncomeOverridesPage').then((m) => ({
    default: m.ScenarioIncomeOverridesPage,
  })),
);
export const ScenarioContributionsPage = lazy(() =>
  import('./pages/ScenarioContributionsPage').then((m) => ({
    default: m.ScenarioContributionsPage,
  })),
);
export const ScenarioReturnsPage = lazy(() =>
  import('./pages/ScenarioReturnsPage').then((m) => ({
    default: m.ScenarioReturnsPage,
  })),
);
export const ScenarioInflationPage = lazy(() =>
  import('./pages/ScenarioInflationPage').then((m) => ({
    default: m.ScenarioInflationPage,
  })),
);
export const ScenarioWithdrawalStrategyPage = lazy(() =>
  import('./pages/ScenarioWithdrawalStrategyPage').then((m) => ({
    default: m.ScenarioWithdrawalStrategyPage,
  })),
);
export const ScenarioRothConversionsPage = lazy(() =>
  import('./pages/ScenarioRothConversionsPage').then((m) => ({
    default: m.ScenarioRothConversionsPage,
  })),
);
export const ScenarioQcdPage = lazy(() =>
  import('./pages/ScenarioQcdPage').then((m) => ({
    default: m.ScenarioQcdPage,
  })),
);
export const ScenarioFloorsPage = lazy(() =>
  import('./pages/ScenarioFloorsPage').then((m) => ({
    default: m.ScenarioFloorsPage,
  })),
);
export const BalanceProjectionPage = lazy(() =>
  import('./pages/BalanceProjectionPage').then((m) => ({ default: m.BalanceProjectionPage })),
);
export const WithdrawalGuidancePage = lazy(() =>
  import('./pages/WithdrawalGuidancePage').then((m) => ({
    default: m.WithdrawalGuidancePage,
  })),
);
export const GuardrailsPage = lazy(() =>
  import('./pages/GuardrailsPage').then((m) => ({
    default: m.GuardrailsPage,
  })),
);
export const ExpenseCategoriesPage = lazy(() =>
  import('./pages/ExpenseCategoriesPage').then((m) => ({ default: m.ExpenseCategoriesPage })),
);
export const ExpensesPage = lazy(() =>
  import('./pages/ExpensesPage').then((m) => ({ default: m.ExpensesPage })),
);
export const IncomePage = lazy(() =>
  import('./pages/IncomePage').then((m) => ({ default: m.IncomePage })),
);
export const IncomeFormPage = lazy(() =>
  import('./pages/IncomeFormPage').then((m) => ({ default: m.IncomeFormPage })),
);
export const ExpenseFormPage = lazy(() =>
  import('./pages/ExpenseFormPage').then((m) => ({ default: m.ExpenseFormPage })),
);
export const ScenarioAssetMixPage = lazy(() =>
  import('./pages/ScenarioAssetMixPage').then((m) => ({ default: m.ScenarioAssetMixPage })),
);
export const SsOptimizerPage = lazy(() =>
  import('./pages/SsOptimizerPage').then((m) => ({ default: m.SsOptimizerPage })),
);
export const RothBETRPage = lazy(() =>
  import('./pages/RothBETRPage').then((m) => ({ default: m.RothBETRPage })),
);
export const ReportPage = lazy(() =>
  import('./pages/ReportPage').then((m) => ({ default: m.ReportPage })),
);
export const WhatsNewPage = lazy(() =>
  import('./pages/WhatsNewPage').then((m) => ({ default: m.WhatsNewPage })),
);
