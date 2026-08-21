import { defineLearningApp } from '@babysteps/consumer-app-container';
import { chessPatternTrainingActivity } from './src/activity.mjs';

export default defineLearningApp({
  id: 'chessmaster',
  activity: chessPatternTrainingActivity,
});
