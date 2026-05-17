export interface User {
  id: string;
  email: string;
  username: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface PantryItem {
  id: string;
  pantry_id: string;
  name: string;
  category?: string;
  quantity: number;
  unit?: string;
  expiry_date?: string;
  added_at?: string;
  updated_at?: string;
}

export interface Recipe {
  id: string;
  title: string;
  description?: string;
  difficulty: 'easy' | 'medium';
  preparation_time: number;
  servings: number;
  ingredients: any[];
  instructions: any[];
  tags?: string[];
  image_url?: string;
  created_at?: string;
}

export interface RecipeHistory {
  id: string;
  user_id: string;
  recipe_id?: string;
  meal_type: 'breakfast' | 'lunch' | 'dinner';
  completed_date: string;
  rating?: number;
  notes?: string;
  created_at?: string;
  updated_at?: string;
  title?: string; // from join
}

export interface Suggestion extends Recipe {
  wasExecuted: boolean;
  matchPct: number;
  ingredientMatch: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
}
