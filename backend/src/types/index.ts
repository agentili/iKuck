export interface User {
  id: string;
  email: string;
  username: string;
  password_hash?: string;
  created_at: Date;
  updated_at: Date;
}

export interface Pantry {
  id: string;
  user_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface PantryItem {
  id: string;
  pantry_id: string;
  name: string;
  category?: string;
  quantity: number;
  unit?: string;
  expiry_date?: Date;
  added_at: Date;
  updated_at: Date;
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
  created_at: Date;
}

export interface RecipeHistory {
  id: string;
  user_id: string;
  recipe_id?: string;
  meal_type: 'breakfast' | 'lunch' | 'dinner';
  completed_date: Date;
  rating?: number;
  notes?: string;
  created_at: Date;
  updated_at: Date;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
