import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuthStore } from '../store/authStore';
import { useNavigate, Link } from 'react-router-dom';

const registerSchema = z.object({
  email: z.string().email('Email non valida'),
  username: z.string().min(3, 'Username min 3 caratteri'),
  password: z.string().min(8, 'Password min 8 caratteri'),
});

type RegisterForm = z.infer<typeof registerSchema>;

const RegisterPage: React.FC = () => {
  const { register: signup } = useAuthStore();
  const navigate = useNavigate();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<RegisterForm>({
    resolver: zodResolver(registerSchema),
  });

  const onSubmit = async (data: RegisterForm) => {
    try {
      await signup(data.email, data.password, data.username);
      navigate('/suggest');
    } catch (err) {
      console.error(err);
      alert('Registrazione fallita. Riprova.');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 bg-gray-100">
      <div className="w-full max-w-md p-8 bg-white rounded-lg shadow-md">
        <h1 className="mb-6 text-2xl font-bold text-center text-primary">Crea un account</h1>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Username</label>
            <input
              type="text"
              {...register('username')}
              className="w-full p-2 mt-1 border rounded-md focus:ring-primary focus:border-primary"
            />
            {errors.username && <p className="mt-1 text-xs text-red-500">{errors.username.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Email</label>
            <input
              type="email"
              {...register('email')}
              className="w-full p-2 mt-1 border rounded-md focus:ring-primary focus:border-primary"
            />
            {errors.email && <p className="mt-1 text-xs text-red-500">{errors.email.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Password</label>
            <input
              type="password"
              {...register('password')}
              className="w-full p-2 mt-1 border rounded-md focus:ring-primary focus:border-primary"
            />
            {errors.password && <p className="mt-1 text-xs text-red-500">{errors.password.message}</p>}
          </div>
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-2 text-white bg-primary rounded-md hover:bg-emerald-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Registrazione in corso...' : 'Registrati'}
          </button>
        </form>
        <p className="mt-4 text-sm text-center text-gray-600">
          Hai già un account? <Link to="/login" className="text-primary hover:underline">Accedi</Link>
        </p>
      </div>
    </div>
  );
};

export default RegisterPage;
