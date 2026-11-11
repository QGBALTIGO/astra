import { Hono } from 'hono';
import { customerAuthRoutes } from './auth.js';
import { customerAccountRoutes } from './account.js';
import { customerFinanceRoutes } from './finance.js';
import { customerAgendaRoutes } from './agenda.js';
import { customerPlanningRoutes } from './planning.js';
import { customerDataRoutes } from './data.js';
import { requireCustomerSession } from '../../middleware/customer-session.js';
import { apiError } from '../helpers.js';

/** Mount before owner authentication; this router terminates every customer path. */
export const customerRoutes = new Hono();
customerRoutes.route('/auth', customerAuthRoutes);
customerRoutes.use('*', requireCustomerSession);
customerRoutes.route('/', customerAccountRoutes);
customerRoutes.route('/finance', customerFinanceRoutes);
customerRoutes.route('/planning', customerPlanningRoutes);
customerRoutes.route('/agenda', customerAgendaRoutes);
customerRoutes.route('/', customerDataRoutes);
customerRoutes.all('*', (c) =>
  apiError(c, { code: 'NOT_FOUND', message: 'Página não encontrada.' }, 404)
);
