import axios from 'axios';

export const apiClient = axios.create({
  baseURL: '/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('meal_planner_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('meal_planner_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export const get = <T>(url: string) => apiClient.get<T>(url).then((res) => res.data);
export const post = <T>(url: string, data: any) => apiClient.post<T>(url, data).then((res) => res.data);
export const put = <T>(url: string, data: any) => apiClient.put<T>(url, data).then((res) => res.data);
export const del = <T>(url: string) => apiClient.delete<T>(url).then((res) => res.data);
