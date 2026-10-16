export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "AppError";
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errors = {
  badRequest: (message: string, code?: string) => 
    new AppError(400, message, code),
  
  unauthorized: (message: string, code?: string) => 
    new AppError(401, message, code),
  
  forbidden: (message: string, code?: string) =>    
    new AppError(403, message, code),
  
  notFound: (message: string, code?: string) => 
    new AppError(404, message, code),
  
  conflict: (message: string, code?: string) => 
    new AppError(409, message, code),
  
  internal: (message: string, code?: string) => 
    new AppError(500, message, code),
};
